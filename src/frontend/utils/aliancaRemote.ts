import { initializeApp, type FirebaseApp } from "firebase/app"
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, type Auth } from "firebase/auth"
import { getDatabase, onValue, ref, set, update, type Database } from "firebase/database"
import { get, writable } from "svelte/store"
import { uid } from "uid"
import { Main } from "../../types/IPC/Main"
import { OutputHelper } from "../components/helpers/OutputHelper"
import { clearAll } from "../components/output/clear"
import { getActiveOutputs } from "../components/helpers/output"
import { getSlideText } from "../components/edit/scripts/textStyle"
import { activeProject, activeShow, outputs, outputDisplay, projects, shows, showsCache } from "../stores"
import { openProjectItem } from "../components/show/project"
import { getActiveScripturesContent, getScriptureShow, loadJsonBible } from "../components/drawer/bible/scripture"
import { history } from "../components/helpers/history"
import { loadShows } from "../components/helpers/setShow"
import { activeScripture, drawerTabsData, scriptureSettings, scriptures } from "../stores"
import { requestMain, sendMain } from "../IPC/main"
import { folders, media, mediaFolders, projects, shows } from "../stores"
import { save } from "./save"

/**
 * Ponte com o AliancaShow Remote (o webapp).
 *
 * A equipe envia fotos, videos e musicas pelo celular; aqui esses envios viram
 * arquivos no disco e projetos prontos, com a MESMA arvore do Firebase Storage:
 *
 *     Alianca/2026/09-setembro/06     -> pastas Alianca > 2026 > 09-setembro, projeto "06"
 *
 * A ligacao e so de saida: o app abre a conexao com o Firebase, nunca recebe
 * conexao. E o que permite funcionar atras do firewall da igreja, sem porta
 * aberta e sem permissao de administrador.
 */

const firebaseConfig = {
    apiKey: "AIzaSyCQbcuXkMgJWxOF2ZdbBKumnd2nnDLbDvA",
    authDomain: "aliancashow-8fb44.firebaseapp.com",
    databaseURL: "https://aliancashow-8fb44-default-rtdb.firebaseio.com",
    projectId: "aliancashow-8fb44",
    storageBucket: "aliancashow-8fb44.firebasestorage.app",
    messagingSenderId: "609682479414",
    appId: "1:609682479414:web:3ccdafe7d59d35ac3efb97"
}

/**
 * As agendas.
 *
 * Sao dois cultos distintos, cada um com seu computador: Alianca todo domingo
 * e Impulso a cada quinze dias no sabado. Nao dividem nada -- nem projeto, nem
 * ordem do culto, nem catalogo -- entao no banco cada uma tem seu proprio
 * espaco, e aqui cada instalacao escolhe qual opera.
 *
 * As datas nunca se cruzam (sabado contra domingo), mas a separacao nao se
 * apoia nisso: e o caminho que separa, nao o calendario.
 */
export type Agenda = { id: string; nome: string; pasta: string; dia: number; cada: number; inicio: string }

export const AGENDAS: Agenda[] = [
    { id: "alianca", nome: "Aliança", pasta: "Alianca", dia: 0, cada: 7, inicio: "" },
    // a cada 15 dias contados a partir de 19/09/2026, o proximo Impulso
    { id: "impulso", nome: "Impulso", pasta: "Impulso", dia: 6, cada: 14, inicio: "2026-09-19" },
    // sem cadencia: evento avulso, criado a mao quando aparece
    { id: "extra", nome: "Extra", pasta: "Extra", dia: -1, cada: 0, inicio: "" }
]

let agenda: Agenda = AGENDAS[0]

/** para a tela acompanhar a troca; o valor que manda continua sendo o de cima */
export const agendaId = writable(AGENDAS[0].id)

export function agendaAtual() {
    return agenda
}

export async function escolherAgenda(id: string) {
    const nova = AGENDAS.find((a) => a.id === id)
    if (!nova || nova.id === agenda.id) return

    agenda = nova
    agendaId.set(nova.id)
    sendMain(Main.SET_STORE_VALUE, { file: "config", key: "aliancaAgenda", value: nova.id })

    // o que estava guardado e de outro culto: comecar limpo evita que um
    // registro do Alianca mande apagar item do Impulso
    vindosDoRemote = {}
    chavesPorRef = {}
    guardarRegistro()

    // a arvore no disco e por culto: a do Impulso ainda nao existe
    pastasNoDiscoFeitas = false

    estado.agenda = nova.id
    avisar()

    // reassina tudo: os caminhos mudaram
    if (estado.ligado) religar()
}

let agendaCarregada = false

export async function carregarAgenda() {
    if (agendaCarregada) return
    agendaCarregada = true

    const guardada = await requestMain(Main.GET_STORE_VALUE, { file: "config", key: "aliancaAgenda" })
    agenda = AGENDAS.find((a) => a.id === guardada) || AGENDAS[0]
    agendaId.set(agenda.id)
    estado.agenda = agenda.id
}

/** raiz de tudo o que e desta agenda no banco */
function caminho(resto: string) {
    return `agendas/${agenda.id}/${resto}`
}

export type EstadoRemote = { ligado: boolean; entrando: boolean; email: string; erro: string; ultimaSync: number; baixando: number; principal: boolean; dono: string; agenda: string; erroSync: string }

let app: FirebaseApp | null = null
let auth: Auth | null = null
let db: Database | null = null
let pararOuvinte: (() => void) | null = null
let pararComandos: (() => void) | null = null
let pararEstado: (() => void) | null = null
let pararCatalogo: (() => void) | null = null
let pararBiblia: (() => void) | null = null
let pararProjetos: (() => void) | null = null
let pararDono: (() => void) | null = null
let batidaDono: ReturnType<typeof setInterval> | null = null
let aoMudarEstado: ((e: EstadoRemote) => void) | null = null

const estado: EstadoRemote = { ligado: false, entrando: false, email: "", erro: "", ultimaSync: 0, baixando: 0, principal: false, dono: "", agenda: "alianca", erroSync: "" }

function avisar() {
    aoMudarEstado?.({ ...estado })
}

export function observarEstado(fn: (e: EstadoRemote) => void) {
    aoMudarEstado = fn
    avisar()
}

const MENSAGENS: { [k: string]: string } = {
    "auth/invalid-email": "E-mail inválido.",
    "auth/invalid-credential": "E-mail ou senha incorretos.",
    "auth/wrong-password": "E-mail ou senha incorretos.",
    "auth/user-not-found": "E-mail ou senha incorretos.",
    "auth/network-request-failed": "Sem conexão com a internet.",
    "auth/too-many-requests": "Muitas tentativas. Aguarde alguns minutos."
}

function iniciar() {
    if (app) return
    app = initializeApp(firebaseConfig, "aliancaRemote")
    auth = getAuth(app)
    db = getDatabase(app)

    onAuthStateChanged(auth, (usuario) => {
        estado.ligado = !!usuario
        estado.email = usuario?.email || ""
        estado.entrando = false
        avisar()

        if (usuario) {
            carregarAgenda().then(ligarObservadores)
        } else {
            desligarObservadores()
        }
    })
}

function ligarObservadores() {
    ouvirCultos()
    ouvirComandos()
    observarEstadoDaSaida()
    observarCatalogo()
    observarBiblia()
    observarProjetos()
    prepararIdentidade().then(observarDono)
}

function desligarObservadores() {
    pararOuvinte?.()
    pararOuvinte = null
    pararComandos?.()
    pararComandos = null
    pararEstado?.()
    pararEstado = null
    pararCatalogo?.()
    pararCatalogo = null
    pararBiblia?.()
    pararBiblia = null
    pararProjetos?.()
    pararProjetos = null
    pararDono?.()
    pararDono = null
    if (batidaDono) clearInterval(batidaDono)
    batidaDono = null
    donoAtual = null
    estado.principal = false
    estado.dono = ""
}

/**
 * Trocar de agenda muda todos os caminhos, entao nao basta mudar a variavel:
 * as assinaturas abertas continuariam ouvindo o culto antigo. Aqui tudo e
 * refeito, e as assinaturas de estado voltam zeradas para publicar de novo no
 * lugar certo.
 */
function religar() {
    desligarObservadores()
    ultimoEstado = ""
    ultimoCatalogo = ""
    ultimoIndiceBiblia = ""
    ligarObservadores()
}

export async function entrar(email: string, senha: string) {
    iniciar()
    estado.entrando = true
    estado.erro = ""
    avisar()

    try {
        await signInWithEmailAndPassword(auth!, email.trim(), senha)
        // guarda no config LOCAL (AppData), nunca nas configuracoes sincronizadas:
        // senha nao deve viajar para a nuvem junto com o resto
        sendMain(Main.SET_STORE_VALUE, { file: "config", key: "aliancaRemote", value: { email: email.trim(), senha } })
    } catch (err: any) {
        estado.erro = MENSAGENS[err?.code] || "Não foi possível entrar."
        estado.entrando = false
        console.error("AliançaShow Remote:", err?.code, err?.message)
    }
    avisar()
}

export function sair() {
    sendMain(Main.SET_STORE_VALUE, { file: "config", key: "aliancaRemote", value: null })
    if (auth) signOut(auth)
}

/** Entra sozinho na inicializacao, se ja houver conta guardada */
export async function entrarSalvo() {
    const salvo: any = await requestMain(Main.GET_STORE_VALUE, { file: "config", key: "aliancaRemote" })
    if (!salvo?.email || !salvo?.senha) return
    entrar(salvo.email, salvo.senha)
}

// ---------------------------------------------------------------- sincronizacao

/**
 * Uma sincronizacao por vez.
 *
 * Cada escrita no Firebase dispara o ouvinte, e antes as execucoes se
 * atropelavam no meio de um download: uma comecava, a outra pulava o item que
 * ja estava baixando e terminava com a lista pela metade. Isso passou a ser
 * grave depois da remocao, porque lista pela metade vira "sumiu" -- entao a
 * ultima foto enviada podia apagar a anterior. Aqui a nova espera a atual
 * acabar, e so a fotografia mais recente e processada.
 */
let sincronizando = false
let proximaFoto: { [id: string]: any } | null = null

function enfileirar(cultos: { [id: string]: any }) {
    proximaFoto = cultos
    if (sincronizando) return
    sincronizando = true
    ;(async () => {
        try {
            while (proximaFoto) {
                const atual = proximaFoto
                proximaFoto = null
                await sincronizar(atual)
            }
            publicarDiagnostico("")
        } catch (e: any) {
            console.error("Falha ao sincronizar:", e)
            publicarDiagnostico(`${passo}: ${e?.message || e}`)
        } finally {
            sincronizando = false
        }
    })()
}

/**
 * Onde a sincronizacao estava e o que deu errado.
 *
 * Duas vezes hoje ela parou no meio e o erro morreu no console do app, onde
 * ninguem olha -- de fora, so dava para ver que nada chegava. Publicado, o
 * problema aparece nas configuracoes e tambem pode ser lido de longe.
 */
let passo = ""
let ultimoDiagnostico = ""

function publicarDiagnostico(erro: string) {
    estado.erroSync = erro
    avisar()

    const assinatura = `${erro}|${passo}`
    if (assinatura === ultimoDiagnostico) return
    ultimoDiagnostico = assinatura

    if (!db || !estado.ligado) return
    set(ref(db, caminho("diagnostico")), { erro, passo, em: Date.now() }).catch(() => {
        ultimoDiagnostico = ""
    })
}

function ouvirCultos() {
    if (!db || pararOuvinte) return

    pararOuvinte = onValue(
        ref(db, caminho("cultos")),
        (snap) => {
            enfileirar(snap.val() || {})
        },
        (erro) => {
            console.error("Falha ao ler os cultos:", erro)
            estado.erro = "Sem acesso aos cultos. Confira a conta."
            avisar()
        }
    )
}

/**
 * Controle remoto pela internet.
 *
 * O FreeShow ja traz um controle remoto embutido, mas ele exige que o celular
 * alcance o computador pela rede local -- e a rede da igreja costuma bloquear
 * isso. Aqui o comando passa pelo Firebase, que os dois lados ja alcancam.
 *
 * O proprio FreeShow tem um caminho parecido em remoteController.ts, so que
 * apontando para o banco do projeto original. Os comandos do culto passariam
 * pelo servidor de outra pessoa, entao este usa o banco da propria igreja, com
 * a conexao que ja existe e ja esta autenticada.
 *
 * Um campo so, sobrescrito a cada toque: nao interessa historico de comando, e
 * fila seria pior -- passar dois slides por acumulo de atraso e mais confuso do
 * que perder um toque. O campo e limpo assim que executa, para o mesmo comando
 * nao repetir se o ouvinte reconectar.
 */
/** Depois disto o comando e considerado perdido. Folgado o bastante para
 *  aguentar internet ruim e relogio de celular fora de hora, curto o bastante
 *  para nao ressuscitar um toque de horas atras. */
const VALIDADE_COMANDO = 30_000

const COMANDOS: { [k: string]: (valor: any) => void } = {
    proximo: () => OutputHelper.advanceOutputs("next"),
    anterior: () => OutputHelper.advanceOutputs("previous"),
    // mesma acao do botao "Limpar tudo": alguem atravessa na frente do
    // projetor, entra a midia errada -- e a funcao que se procura com pressa e
    // a unica do transporte que faltava no celular
    limpar: () => clearAll(true),
    // saltar direto para um item do culto, sem passar slide por slide
    abrir: (valor) => {
        const projetoId = get(activeProject)
        if (!projetoId || typeof valor?.indice !== "number") return
        openProjectItem(projetoId, valor.indice)
    }
}

function ouvirComandos() {
    if (!db || pararComandos) return

    pararComandos = onValue(
        ref(db!, caminho("comando")),
        (snap) => {
            const valor = snap.val()
            if (!valor?.acao) return

            // So obedece comando recente. onValue dispara com o que ja estava
            // no banco assim que conecta, entao um toque dado com o computador
            // desligado seria executado na abertura do app -- o slide pularia
            // sozinho no domingo de manha. Passado o prazo, limpa sem executar.
            const idade = Date.now() - (valor.em || 0)
            if (idade > VALIDADE_COMANDO) {
                set(ref(db!, caminho("comando")), null).catch(() => {})
                return
            }

            const executar = COMANDOS[valor.acao]
            if (!executar) {
                console.warn("Comando remoto desconhecido:", valor.acao)
                return
            }

            executar(valor)

            // limpa para o mesmo toque nao repetir numa reconexao
            set(ref(db!, caminho("comando")), null).catch((erro) => console.error("Falha ao limpar o comando:", erro))
        },
        (erro) => {
            console.error("Falha ao ouvir comandos remotos:", erro)
        }
    )
}

/**
 * Publica o que esta acontecendo no computador, para o celular deixar de ser
 * cego. Ate aqui o desktop so escrevia no banco para limpar comando: quem
 * apertava o botao nao tinha como saber se o slide mudou -- o retorno era
 * local, o celular acendia porque ele mesmo mandou acender.
 *
 * Com o indice publicado, o controle confirma o que de fato aconteceu, e a
 * pessoa acompanha a letra sem ver o projetor.
 *
 * So escreve quando algo muda de verdade, e no maximo a cada meio segundo:
 * segurar a seta para avancar varios slides dispararia uma escrita por slide.
 */
let ultimoEstado = ""
let estadoAgendado: ReturnType<typeof setTimeout> | null = null

/**
 * Qual computador manda no culto.
 *
 * Mais de uma instalacao com a mesma conta e o caso normal aqui: a maquina da
 * igreja e a que fica em casa para preparar. Sem um dono, as duas espelham o
 * proprio projeto e apagam do banco o que nao esta nele -- uma desfazendo a
 * outra, ate o culto esvaziar no celular.
 *
 * Entao: quem recebe e baixa continua sendo toda maquina ligada; quem PUBLICA
 * (ordem do culto, catalogo, indice da Biblia e o espelho do projeto) e so a
 * principal. O posto e tomado por quem chegar primeiro e mantido por uma
 * batida a cada 45s; parado por mais de dois minutos e meio, ele fica livre --
 * assim fechar o app da igreja nao deixa ninguem travado.
 */
const VALIDADE_DONO = 150_000

let meuId = ""
let meuNome = ""
let donoAtual: { id?: string; nome?: string; em?: number } | null = null

async function prepararIdentidade() {
    if (meuId) return
    meuId = (await requestMain(Main.GET_STORE_VALUE, { file: "config", key: "aliancaIdDoComputador" })) || ""
    if (!meuId) {
        meuId = uid(8)
        sendMain(Main.SET_STORE_VALUE, { file: "config", key: "aliancaIdDoComputador", value: meuId })
    }
    meuNome = (await requestMain(Main.GET_DEVICE_NAME)) || "Computador"
}

function souPrincipal() {
    return !!meuId && donoAtual?.id === meuId
}

function postoVago() {
    return !donoAtual?.id || !donoAtual?.em || Date.now() - donoAtual.em > VALIDADE_DONO
}

async function reivindicar(forcado = false) {
    if (!db || !estado.ligado || !meuId) return
    if (!forcado && !souPrincipal() && !postoVago()) return

    try {
        await set(ref(db, caminho("controle/dono")), { id: meuId, nome: meuNome, em: Date.now() })
    } catch (erro) {
        console.error("Falha ao anunciar o computador principal:", erro)
    }
}

/** usado pelo botao: passa o posto para este computador na hora */
export function assumirControle() {
    return reivindicar(true)
}

function observarDono() {
    if (pararDono) return

    pararDono = onValue(ref(db!, caminho("controle/dono")), (snap) => {
        donoAtual = snap.val()
        estado.principal = souPrincipal()
        estado.dono = donoAtual?.nome || ""
        avisar()

        // o posto ficou livre (a outra maquina fechou): assume sem pedir nada
        if (postoVago()) reivindicar()
    })

    reivindicar()
    batidaDono = setInterval(() => reivindicar(), 45_000)
}

function publicarEstado() {
    if (!db || !estado.ligado || !souPrincipal()) return

    const saidaId = getActiveOutputs(get(outputs), true, true, true)[0]
    const saida = get(outputs)[saidaId]?.out?.slide
    const show = saida?.id ? get(showsCache)[saida.id] : null

    const layout = show?.layouts?.[saida?.layout || show?.settings?.activeLayout || ""]
    const total = layout?.slides?.length || 0
    const indice = typeof saida?.index === "number" ? saida.index : -1

    const slide = indice >= 0 && saida?.id ? show?.slides?.[layout?.slides?.[indice]?.id || ""] : null
    const texto = slide ? getSlideText(slide).slice(0, 200) : ""

    // A ordem do culto, para o celular poder saltar direto a um item em vez de
    // passar slide por slide. Nome resolvido aqui: o item guarda so o id, e o
    // celular nao tem a biblioteca de shows para traduzir.
    const projetoId = get(activeProject)
    const projeto = projetoId ? get(projects)[projetoId] : null
    const itens = (projeto?.shows || []).slice(0, 100).map((item: any) => ({
        nome: get(shows)[item.id]?.name || item.name || "—",
        tipo: item.type || "show"
    }))
    const itemAtual = typeof get(activeShow)?.index === "number" ? get(activeShow)!.index! : -1

    const novo = {
        noAr: !!get(outputDisplay),
        show: show?.name || "",
        indice,
        total,
        texto,
        culto: projeto?.name || "",
        itens,
        itemAtual,
        em: Date.now()
    }

    // "em" muda sempre, entao fica fora da comparacao
    const assinatura = JSON.stringify({ ...novo, em: 0 })
    if (assinatura === ultimoEstado) return
    ultimoEstado = assinatura

    if (estadoAgendado) return
    estadoAgendado = setTimeout(() => {
        estadoAgendado = null
        set(ref(db!, caminho("estado")), novo).catch((erro) => {
            ultimoEstado = ""
            console.error("Falha ao publicar o estado:", erro)
        })
    }, 500)
}

/**
 * Publica a biblioteca de shows como catalogo, para o celular escolher musica.
 *
 * Fica FORA da agenda, ao contrario do resto: o repertorio e o mesmo nos dois
 * cultos, e uma copia por agenda faria o Impulso aparecer sem louvor nenhum ate
 * o computador dele ligar pela primeira vez.
 *
 * O catalogo e indexado pelo id do show, e e esse id que volta quando alguem
 * adiciona uma musica ao culto. Enquanto ninguem publicava, a lista precisava
 * ser mantida a mao em algum lugar -- e um id que nao batesse com esta
 * biblioteca fazia a musica ser descartada em silencio.
 *
 * Publicando daqui, os ids batem por construcao, e musica nova aparece no
 * celular assim que existe no computador.
 */
let ultimoCatalogo = ""

function publicarCatalogo() {
    if (!db || !estado.ligado || !souPrincipal()) return

    const catalogo: { [id: string]: { nome: string } } = {}
    Object.entries(get(shows)).forEach(([id, show]: any) => {
        if (!show?.name || show.private) return
        catalogo[id] = { nome: show.name }
    })

    const assinatura = JSON.stringify(catalogo)
    if (assinatura === ultimoCatalogo) return
    ultimoCatalogo = assinatura

    set(ref(db!, "catalogo"), catalogo).catch((erro) => {
        // limpa a assinatura: sem isso uma escrita recusada (regra do banco,
        // internet fora) faria o app achar que ja publicou e nunca mais tentar.
        // Foi assim que o catalogo ficou meses sem sair daqui.
        ultimoCatalogo = ""
        console.error("Falha ao publicar o catalogo:", erro)
    })
}

/** a primeira biblia local instalada -- e nela que as referencias sao resolvidas */
function idDaBibliaLocal() {
    const todas = get(scriptures) as any
    return Object.keys(todas).find((id) => !todas[id]?.api && !todas[id]?.collection) || ""
}

/**
 * Publica a estrutura da Biblia: nomes dos livros e quantos capitulos cada um.
 *
 * O celular precisa disso para montar os seletores, e nao tem a Biblia. Pelo
 * mesmo motivo do catalogo de musicas: quem tem a informacao e quem publica --
 * manter essa lista a mao foi o que fez louvor sumir sem explicacao.
 *
 * So a estrutura, nao o texto. O versiculo e resolvido aqui na hora de montar
 * o show, e publicar a NVI inteira seria outro tamanho de problema.
 */
let ultimoIndiceBiblia = ""

async function publicarIndiceBiblia() {
    if (!db || !estado.ligado || !souPrincipal()) return

    const bibliaId = idDaBibliaLocal()
    if (!bibliaId) return

    const biblia = await loadJsonBible(bibliaId)
    const livros = ((biblia?.data as any)?.books || []).map((livro: any) => ({
        nome: livro.name || "",
        capitulos: (livro.chapters || []).length
    }))
    if (!livros.length) return

    const indice = { versao: (get(scriptures) as any)[bibliaId]?.name || "", livros }

    const assinatura = JSON.stringify(indice)
    if (assinatura === ultimoIndiceBiblia) return
    ultimoIndiceBiblia = assinatura

    set(ref(db!, "biblia"), indice).catch((erro) => {
        ultimoIndiceBiblia = ""
        console.error("Falha ao publicar o indice da Biblia:", erro)
    })
}

/**
 * Monta o show de um versiculo escolhido no celular.
 *
 * Reaproveita o mesmo caminho da aba Biblia (getScriptureShow), em vez de
 * remontar slides aqui: sao mais de mil linhas de tratamento -- numeracao,
 * versiculos longos, referencia, template -- que nao valem ser duplicadas.
 *
 * Para isso a referencia precisa estar em activeScripture, que e estado de
 * interface. E emprestado e devolvido em seguida.
 *
 * O id do show e derivado da referencia, entao sincronizar de novo sobrescreve
 * o mesmo show em vez de encher a biblioteca de copias.
 */
async function criarShowDeVersiculo(item: any, projetoId: string) {
    const versiculos: number[] = Array.isArray(item.versiculos) ? item.versiculos : []
    if (!versiculos.length) return ""

    const bibliaId = idDaBibliaLocal()
    if (!bibliaId) {
        console.warn("AliancaShow Remote: nenhuma Biblia local instalada, versiculo ignorado")
        return ""
    }

    // O celular manda o INDICE do livro na lista publicada; o json-bible resolve
    // pelo NUMERO do livro (Genesis = 1). Usar um no lugar do outro tirava um
    // livro inteiro de diferenca -- pedir Juizes trazia Josue. A conversao sai
    // da propria lista publicada, e nao de "indice + 1", porque a numeracao de
    // uma Biblia com apocrifos ou fora de ordem nao acompanharia a posicao.
    const biblia = await loadJsonBible(bibliaId)
    const livroNumero = Number((biblia?.data as any)?.books?.[item.livro]?.number ?? Number(item.livro) + 1)

    const showId = `bib-${livroNumero}-${item.capitulo}-${versiculos[0]}-${versiculos[versiculos.length - 1]}`

    // Ja existe: so referenciar, desde que tenha um slide por versiculo. Um
    // show montado por uma versao anterior -- quando o agrupamento por tamanho
    // ainda mandava -- ficou com menos slides do que versiculos, e sem esta
    // conferencia seria reaproveitado para sempre: Genesis 1:1-10 voltaria com
    // quatro slides por mais que a regra tivesse mudado.
    if (get(shows)[showId]) {
        await loadShows([showId])
        const existente: any = get(showsCache)[showId]
        const leiaute = existente?.layouts?.[existente?.settings?.activeLayout || Object.keys(existente?.layouts || {})[0] || ""]
        if ((leiaute?.slides?.length || 0) === versiculos.length) return showId
    }

    const refAnterior = get(activeScripture)
    const abaAnterior = (get(drawerTabsData) as any).scripture?.activeSubTab
    const porSlideAnterior = get(scriptureSettings).versesPerSlide
    const agrupamentoAnterior = get(scriptureSettings).smartSplit

    try {
        // Regra do AliancaShow: um versiculo por slide. O agrupamento
        // inteligente precisa sair junto -- ele junta versiculos ate encher o
        // slide e ignora quantos por slide foram pedidos, entao Genesis 1:1-10
        // saia em quatro slides em vez de dez.
        scriptureSettings.update((a: any) => ({ ...a, versesPerSlide: 1, smartSplit: false }))
        drawerTabsData.update((a: any) => {
            if (!a.scripture) a.scripture = {}
            a.scripture.activeSubTab = bibliaId
            return a
        })
        activeScripture.set({ id: bibliaId, reference: { book: livroNumero, chapters: [item.capitulo], verses: [versiculos] } })

        const conteudo = await getActiveScripturesContent([versiculos])
        const show = await getScriptureShow(conteudo)
        if (!show) return ""

        history({
            id: "UPDATE",
            oldData: { id: showId },
            // sem "remember": ele empurra o show para o projeto sem olhar se ja
            // esta la, e remontar um versiculo existente criava uma segunda
            // linha no culto. Quem poe no projeto e adicionarAoProjeto, que
            // confere antes -- e ainda marca o tipo, que este caminho nao marca
            newData: { data: show },
            location: { page: "show", id: "show" }
        })

        return showId
    } catch (erro) {
        console.error("Falha ao montar o versiculo:", erro)
        return ""
    } finally {
        activeScripture.set(refAnterior)
        scriptureSettings.update((a: any) => ({ ...a, versesPerSlide: porSlideAnterior, smartSplit: agrupamentoAnterior }))
        drawerTabsData.update((a: any) => {
            if (a.scripture) a.scripture.activeSubTab = abaAnterior
            return a
        })
    }
}

function observarCatalogo() {
    if (pararCatalogo) return
    // a biblioteca muda pouco; a comparacao de assinatura evita escrita a toa
    pararCatalogo = shows.subscribe(() => publicarCatalogo())
}

function observarBiblia() {
    if (pararBiblia) return
    // Publicar uma vez no login nao bastava: a lista de Biblias vem das
    // configuracoes, que terminam de carregar depois da autenticacao -- entao
    // na hora certa ainda nao havia Biblia nenhuma e o indice saia vazio.
    pararBiblia = scriptures.subscribe(() => publicarIndiceBiblia())
}

function observarEstadoDaSaida() {
    if (pararEstado) return
    // outputs cobre troca de slide e de show; outputDisplay cobre entrar e sair do ar
    const a = outputs.subscribe(() => publicarEstado())
    const b = outputDisplay.subscribe(() => publicarEstado())
    // activeShow cobre trocar de item dentro do culto; activeProject, trocar de culto
    const c = activeShow.subscribe(() => publicarEstado())
    const d = activeProject.subscribe(() => publicarEstado())
    // e projects cobre mexer no culto aberto. Faltava: acrescentar um louvor
    // aqui nao mudava saida, show nem projeto ativo, entao a ordem do culto no
    // celular ficava a do ultimo evento -- sem o item recem-colocado
    const e = projects.subscribe(() => publicarEstado())
    pararEstado = () => {
        a()
        b()
        c()
        d()
        e()
    }
}

/** garante uma pasta pelo caminho, devolvendo o id da ultima */
function garantirPastas(caminho: string[]) {
    let pai = "/"
    let mudou = false

    for (const nome of caminho) {
        const atuais = get(folders)
        const existente = Object.entries(atuais).find(([, f]: any) => f.name === nome && f.parent === pai)

        if (existente) {
            pai = existente[0]
            continue
        }

        const id = uid()
        folders.update((a) => {
            a[id] = { name: nome, parent: pai, created: Date.now() }
            return a
        })
        pai = id
        mudou = true
    }

    return { id: pai, mudou }
}

function garantirProjeto(nome: string, pastaId: string) {
    const atuais = get(projects)
    const existente = Object.entries(atuais).find(([, p]: any) => p.name === nome && p.parent === pastaId)
    if (existente) return { id: existente[0], mudou: false }

    const id = uid()
    projects.update((a) => {
        a[id] = { name: nome, parent: pastaId, created: Date.now(), shows: [] }
        return a
    })
    return { id, mudou: true }
}

/** as duas raizes tambem viram pastas de midia, para a aba Midia mostrar a mesma arvore */
async function garantirPastasDeMidia() {
    const raizOnline: string = await requestMain(Main.ALIANCA_PASTA_ONLINE, undefined as any)
    if (!raizOnline) return false

    const pasta = `${raizOnline}\\${agenda.pasta}`
    if (Object.values(get(mediaFolders)).some((f: any) => f.path === pasta)) return false

    mediaFolders.update((a) => {
        a[uid()] = { name: agenda.pasta, path: pasta, icon: "folder", default: false }
        return a
    })
    return true
}

/** "2026-09-06" -> pastas Alianca/2026/09-setembro + projeto "06" */
const MESES = ["01-janeiro", "02-fevereiro", "03-marco", "04-abril", "05-maio", "06-junho", "07-julho", "08-agosto", "09-setembro", "10-outubro", "11-novembro", "12-dezembro"]
function caminhoDoculto(cultoId: string, nome = "") {
    const data = cultoId.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (!data) return null

    // Culto de data fixa se identifica pelo dia; evento avulso, nao -- "07" nao
    // diz nada, "07 Rede de Mulheres" diz. O dia continua na frente para a
    // ordem do painel sair certa.
    const projeto = nome.trim() ? `${data[3]} ${nome.trim()}`.slice(0, 60) : data[3]
    return { pastas: [agenda.pasta, data[1], MESES[Number(data[2]) - 1]], projeto }
}

/**
 * Cria a arvore inteira de uma vez, mesmo sem conteudo:
 *
 *     Alianca/2026/01-janeiro/04, 11, 18, 25 ... ate 12-dezembro
 *
 * Antes as pastas nasciam quando o primeiro arquivo chegava, entao o painel
 * ficava cheio de buracos: so o domingo com foto aparecia. Com a arvore pronta
 * o operador encontra qualquer culto pelo calendario, tenha conteudo ou nao.
 */
/**
 * Os dias de culto de um mes, na cadencia da agenda.
 *
 * Alianca cai todo domingo; Impulso, a cada quinze dias no sabado, contados a
 * partir de uma data ancora -- sem ela nao daria para saber QUAL sabado, ja
 * que a cada quinze dias sao dois sabados possiveis.
 */
function diasDoMes(ano: number, mes: number) {
    const dias: string[] = []

    // evento avulso nao tem data certa: quem cria e o operador, pelo "+"
    if (!agenda.cada) return dias

    if (agenda.cada === 7) {
        const d = new Date(ano, mes, 1)
        d.setDate(1 + ((7 - d.getDay() + agenda.dia) % 7))
        while (d.getMonth() === mes) {
            dias.push(String(d.getDate()).padStart(2, "0"))
            d.setDate(d.getDate() + 7)
        }
        return dias
    }

    const [a, m, dia] = agenda.inicio.split("-").map(Number)
    const ancora = new Date(a, m - 1, dia)
    const primeiro = new Date(ano, mes, 1)

    // anda da ancora ate o mes pedido, para tras ou para frente
    const passos = Math.floor((primeiro.getTime() - ancora.getTime()) / (agenda.cada * 86400000))
    const d = new Date(ancora)
    d.setDate(d.getDate() + passos * agenda.cada)
    while (d < primeiro) d.setDate(d.getDate() + agenda.cada)

    while (d.getMonth() === mes && d.getFullYear() === ano) {
        dias.push(String(d.getDate()).padStart(2, "0"))
        d.setDate(d.getDate() + agenda.cada)
    }
    return dias
}

/**
 * A arvore no disco ja foi pedida para o culto de agora.
 *
 * Criar as pastas do ano inteiro e caro e basta uma vez por sessao -- mas uma
 * vez POR CULTO: cada agenda tem sua propria pasta raiz, entao trocar para o
 * Impulso zera isto (ver escolherAgenda) para que as pastas dele tambem nascam.
 */
let pastasNoDiscoFeitas = false

function garantirEstruturaCompleta() {
    let mudou = false
    const ano = new Date().getFullYear()
    // um caminho por projeto: e o mesmo desenho que a pasta Online precisa ter
    const caminhos: string[] = []

    for (let mes = 0; mes < 12; mes++) {
        const { id: pastaMes, mudou: m1 } = garantirPastas([agenda.pasta, String(ano), MESES[mes]])
        mudou = mudou || m1
        for (const dia of diasDoMes(ano, mes)) {
            const { mudou: m2 } = garantirProjeto(dia, pastaMes)
            mudou = mudou || m2
            caminhos.push(`${agenda.pasta}/${ano}/${MESES[mes]}/${dia}`)
        }
    }

    // a aba Midia navega o disco, entao a pasta precisa existir de verdade
    if (!pastasNoDiscoFeitas) {
        pastasNoDiscoFeitas = true
        sendMain(Main.ALIANCA_CRIAR_PASTAS, caminhos)
    }

    return mudou
}

/**
 * O que cada culto trouxe do Remote, guardado entre sessoes.
 *
 * Sem isso nao da para desfazer uma remocao com seguranca: o projeto mistura o
 * que chegou do celular com o que o operador arrastou para la, e os dois ficam
 * iguais depois de salvos. So sai do projeto o que ESTE registro diz que entrou
 * por aqui.
 */
let vindosDoRemote: { [culto: string]: string[] } = {}

/**
 * Qual entrada do banco gerou cada item do projeto, culto a culto.
 *
 * Guardado junto do registro, e nao so na memoria: remover um item do culto
 * com o app fechado e o caso comum, e um mapa que nasce vazio a cada abertura
 * nao teria como saber o que apagar -- a sincronizacao leria o banco, veria o
 * item pedido e o traria de volta para o projeto.
 */
let chavesPorRef: { [culto: string]: { [ref: string]: string } } = {}
let registroCarregado = false

async function carregarRegistro() {
    if (registroCarregado) return
    registroCarregado = true
    vindosDoRemote = (await requestMain(Main.GET_STORE_VALUE, { file: "config", key: "aliancaVindosDoRemote" })) || {}
    chavesPorRef = (await requestMain(Main.GET_STORE_VALUE, { file: "config", key: "aliancaChavesPorRef" })) || {}
}

function guardarRegistro() {
    sendMain(Main.SET_STORE_VALUE, { file: "config", key: "aliancaVindosDoRemote", value: vindosDoRemote })
    sendMain(Main.SET_STORE_VALUE, { file: "config", key: "aliancaChavesPorRef", value: chavesPorRef })
}

/** o arquivo so sai do disco se nenhum outro projeto ainda apontar para ele */
function ninguemMaisUsa(caminho: string) {
    return !Object.values(get(projects)).some((p: any) => (p.shows || []).some((s: any) => s.id === caminho))
}

function tirarDoProjeto(cultoId: string, sumiram: string[]) {
    const partes = caminhoDoculto(cultoId)
    if (!partes || !sumiram.length) return false

    const pastaId = garantirPastas(partes.pastas).id
    const projetoId = garantirProjeto(partes.projeto, pastaId).id
    const projeto: any = get(projects)[projetoId]
    if (!projeto) return false

    const fora = new Set(sumiram)
    const restantes = (projeto.shows || []).filter((s: any) => !fora.has(s.id))
    if (restantes.length === (projeto.shows || []).length) return false

    projects.update((a) => {
        a[projetoId].shows = restantes
        return a
    })

    for (const id of sumiram) {
        // musica e referencia ao show, que continua na biblioteca; arquivo e copia
        if (!String(id).includes("\\") && !String(id).includes("/")) continue
        if (!ninguemMaisUsa(id)) continue
        media.update((a) => {
            delete a[id]
            return a
        })
        sendMain(Main.ALIANCA_APAGAR, { caminho: id })
    }

    return true
}

/**
 * Apaga do banco o que o operador tirou do culto aqui no computador.
 *
 * Roda ANTES de ler os itens: feito depois, a leitura ainda veria o item
 * pedido no banco e o traria de volta para o projeto -- foi o que acontecia
 * quando a remocao era feita com o app fechado.
 *
 * Devolve as entradas apagadas, para que esta mesma rodada as ignore.
 */
async function apagarOsQueSairamDoProjeto() {
    const fora = new Set<string>()
    if (!db || !estado.ligado || !souPrincipal()) return fora

    const escritas: { [caminho: string]: null } = {}
    const aEsquecer: { culto: string; referencia: string }[] = []

    for (const [cultoId, mapa] of Object.entries(chavesPorRef)) {
        const partes = caminhoDoculto(cultoId)
        if (!partes) continue

        const projetoId = garantirProjeto(partes.projeto, garantirPastas(partes.pastas).id).id
        const projeto = get(projects)[projetoId] as any
        // projeto que ainda nao existe nao e projeto vazio
        if (!projeto) continue

        const ids = new Set(((projeto.shows || []) as any[]).map((entrada) => String(entrada?.id || "")))

        Object.entries(mapa).forEach(([referencia, chave]) => {
            if (ids.has(referencia)) return
            escritas[`${caminho("cultos")}/${cultoId}/itens/${chave}`] = null
            fora.add(`${cultoId}/${chave}`)
            aEsquecer.push({ culto: cultoId, referencia })
        })
    }

    if (!Object.keys(escritas).length) return fora

    try {
        await update(ref(db!, "/"), escritas)
    } catch (erro) {
        // sem apagar de la, ignorar os itens aqui deixaria os dois lados
        // discordando: melhor nao mexer e tentar na proxima volta
        console.error("Falha ao apagar do celular o que saiu do culto:", erro)
        return new Set<string>()
    }

    aEsquecer.forEach(({ culto, referencia }) => delete chavesPorRef[culto]?.[referencia])
    return fora
}

async function sincronizar(cultos: { [id: string]: any }) {
    passo = "registro"
    await carregarRegistro()

    passo = "pastas de midia"
    let mudou = await garantirPastasDeMidia()

    passo = "estrutura"
    mudou = garantirEstruturaCompleta() || mudou

    passo = "remocoes"
    const removidosAqui = await apagarOsQueSairamDoProjeto()

    // o que o Remote pede AGORA, culto a culto -- a diferenca para o registro
    // anterior e exatamente o que alguem removeu pelo celular
    const pedidos: { [culto: string]: string[] } = {}
    const incompletos = new Set<string>()

    for (const [cultoId, culto] of Object.entries(cultos)) {
        passo = `culto ${cultoId}`
        const itens = Object.entries((culto as any)?.itens || {}).map(([chave, item]: any) => ({ ...item, chaveNoBanco: chave }))
        if (!itens.length) continue

        const partes = caminhoDoculto(cultoId, (culto as any)?.nome)
        if (!partes) continue

        const { id: pastaId, mudou: m1 } = garantirPastas(partes.pastas)
        const { id: projetoId, mudou: m2 } = garantirProjeto(partes.projeto, pastaId)
        mudou = mudou || m1 || m2

        // ordena pela hora de envio, para o projeto seguir a ordem em que a equipe montou
        itens.sort((a, b) => (a.enviadoEm || 0) - (b.enviadoEm || 0))

        const daqui: string[] = []
        pedidos[cultoId] = daqui

        // de qual entrada do banco veio cada id do projeto: e o que permite
        // apagar no celular o item que o operador tirou do culto aqui
        const chaves: { [ref: string]: string } = {}
        // a chave vem por parametro: escrita como fechamento sobre o "item" do
        // laco abaixo, a funcao procurava um nome que ainda nao existia no
        // escopo dela e derrubava a sincronizacao inteira na primeira chamada
        const anotar = (ref: string, chave: string) => {
            if (ref) chaves[ref] = chave
        }

        for (const item of itens) {
            // acabou de sair do culto aqui: ja foi apagado do banco acima
            if (removidosAqui.has(`${cultoId}/${item.chaveNoBanco}`)) continue

            if (item.tipo === "biblia") {
                const showId = await criarShowDeVersiculo(item, projetoId)
                if (showId) {
                    daqui.push(showId)
                    anotar(showId, item.chaveNoBanco)
                    if (adicionarAoProjeto(projetoId, { id: showId, type: "show" }, showId)) mudou = true
                }
                continue
            }

            // Item que o operador montou aqui e este computador publicou. Ja
            // esta no projeto -- so precisa entrar no registro, para que apagar
            // pelo celular tire do projeto como qualquer outro.
            if (item.tipo === "local") {
                if (item.ref) {
                    daqui.push(item.ref)
                    anotar(item.ref, item.chaveNoBanco)
                }
                continue
            }

            if (item.tipo === "musica") {
                daqui.push(item.showId)
                anotar(item.showId, item.chaveNoBanco)
                if (adicionarAoProjeto(projetoId, { id: item.showId, type: "show" }, item.showId)) mudou = true
                continue
            }

            const pasta = [...partes.pastas, partes.projeto].join("/")
            const arquivo = nomeDoArquivo(item)

            estado.baixando++
            avisar()

            const caminhoLocal: string | null = await requestMain(Main.ALIANCA_BAIXAR, { url: item.url, pasta, arquivo })

            estado.baixando--
            avisar()

            // download falho deixa a lista incompleta; sem esta marca o item
            // seria lido como removido e sairia do projeto na volta seguinte
            if (!caminhoLocal) {
                incompletos.add(cultoId)
                continue
            }
            daqui.push(caminhoLocal)
            anotar(caminhoLocal, item.chaveNoBanco)

            const tipoProjeto = item.tipo === "image" ? "image" : item.tipo === "video" ? "video" : "audio"
            if (adicionarAoProjeto(projetoId, { id: caminhoLocal, type: tipoProjeto, name: item.nome }, caminhoLocal)) {
                media.update((a) => {
                    if (!a[caminhoLocal]) a[caminhoLocal] = {}
                    return a
                })
                mudou = true
            }
        }

        // Linha repetida no culto: o mesmo show entrou duas vezes enquanto a
        // remontagem tambem o empurrava para o projeto. Some sozinha em vez de
        // exigir limpeza a mao, culto por culto.
        if (tirarRepetidos(projetoId)) mudou = true

        // So vale o que realmente entrou no projeto. Uma musica que nao existe
        // nesta biblioteca, por exemplo, e ignorada aqui -- anotar mesmo assim
        // faria o proximo passo entender que o operador a removeu, e apagaria
        // do celular um envio que ninguem chegou a ver.
        const noProjeto = new Set(((get(projects)[projetoId] as any)?.shows || []).map((item: any) => item.id))
        chavesPorRef[cultoId] = Object.fromEntries(Object.entries(chaves).filter(([ref]) => noProjeto.has(ref)))
    }

    // um culto esvaziado some do banco, entao a volta e pelo registro, e nao
    // pela lista que chegou
    for (const cultoId of Object.keys(vindosDoRemote)) {
        if (incompletos.has(cultoId)) {
            // na duvida, nao tira nada: guarda a uniao e tenta de novo depois
            const juntos = new Set([...(pedidos[cultoId] || []), ...vindosDoRemote[cultoId]])
            pedidos[cultoId] = [...juntos]
            continue
        }

        const agora = new Set(pedidos[cultoId] || [])
        const sumiram = vindosDoRemote[cultoId].filter((id) => !agora.has(id))
        if (tirarDoProjeto(cultoId, sumiram)) mudou = true
    }

    Object.keys(chavesPorRef).forEach((cultoId) => {
        if (!cultos[cultoId]?.itens) delete chavesPorRef[cultoId]
    })

    const antes = JSON.stringify([vindosDoRemote, chavesPorRef])
    vindosDoRemote = pedidos
    if (JSON.stringify([pedidos, chavesPorRef]) !== antes) guardarRegistro()

    passo = "espelho"
    ultimaFotoCultos = cultos
    await publicarLocais(cultos)
    passo = "pronto"

    if (mudou) {
        estado.ultimaSync = Date.now()
        avisar()
        setTimeout(() => save(), 1500)
    }
}

/**
 * Publica de volta o que foi montado aqui no computador.
 *
 * A ponte nasceu de mao unica: o celular mandava, o computador recebia. So que
 * quem monta o culto tambem arrasta louvor e foto direto daqui, e esses itens
 * nunca existiram no banco -- entao a lista do celular mostrava metade do
 * culto, e a equipe nao tinha como saber o que ja estava resolvido.
 *
 * Aqui esses itens sobem como tipo "local": so o nome e a referencia, sem
 * arquivo. O celular passa a ver o culto inteiro, e apagar por la tira do
 * projeto igual a qualquer envio -- foi uma escolha consciente, e o caminho de
 * remocao ja recusa apagar do disco o que esta fora da pasta Online.
 */
let ultimaFotoCultos: { [id: string]: any } = {}
let publicacaoAgendada: ReturnType<typeof setTimeout> | null = null

function chaveLocal(referencia: string) {
    const limpo = referencia.replace(/[^A-Za-z0-9_-]/g, "_")
    // o caminho de um arquivo passa dos 100 caracteres e a chave precisa ser
    // curta; o resumo no fim evita que dois caminhos parecidos virem a mesma
    let resumo = 0
    for (let i = 0; i < referencia.length; i++) resumo = (resumo * 31 + referencia.charCodeAt(i)) >>> 0
    return `local_${limpo.slice(-60)}_${resumo.toString(36)}`
}

function nomeDoItemLocal(entrada: any) {
    const referencia = String(entrada?.id || "")
    const doShow = get(shows)[referencia]?.name
    if (doShow) return doShow
    if (entrada?.name) return entrada.name
    const arquivo = referencia.split(/[\\/]/).pop() || referencia
    return arquivo.replace(/\.[^.]+$/, "")
}

async function publicarLocais(cultos: { [id: string]: any }) {
    if (!db || !estado.ligado || !souPrincipal()) return

    const usuario = auth?.currentUser
    if (!usuario) return

    await carregarRegistro()

    const escritas: { [caminho: string]: any } = {}
    const ano = new Date().getFullYear()

    // o calendario da agenda mais o que ja existe no banco: o Extra nao tem
    // cadencia, entao seus eventos so aparecem por aqui
    const datas = new Set<string>(Object.keys(cultos))
    for (let mes = 0; mes < 12; mes++) {
        for (const dia of diasDoMes(ano, mes)) datas.add(`${ano}-${String(mes + 1).padStart(2, "0")}-${dia}`)
    }

    for (const cultoId of datas) {
        const partes = caminhoDoculto(cultoId, cultos[cultoId]?.nome)
        if (!partes) continue

        const projetoId = garantirProjeto(partes.projeto, garantirPastas(partes.pastas).id).id

        // projeto que nao existe nao e projeto vazio: sem esta saida, uma
        // leitura antes da hora leria o culto como esvaziado e apagaria
        // tudo que a equipe mandou
        const projeto = get(projects)[projetoId] as any
        if (!projeto) continue

        const noProjeto = projeto.shows || []
        const idsNoProjeto = new Set(noProjeto.map((entrada: any) => String(entrada?.id || "")))

        // o que ja veio do celular nao volta: seria o mesmo item duas vezes
        const doRemote = new Set(vindosDoRemote[cultoId] || [])

        // o que este computador ja publicou, pela referencia
        const publicados = new Map<string, { chave: string; de: string }>()
        Object.entries(cultos[cultoId]?.itens || {}).forEach(([chave, item]: any) => {
            if (item?.tipo === "local" && item.ref) publicados.set(item.ref, { chave, de: item.porComputador || "" })
        })

        noProjeto.forEach((entrada: any, ordem: number) => {
            const referencia = String(entrada?.id || "")
            if (!referencia) return

            // ATENCAO a ordem destas duas checagens. O item publicado daqui
            // volta pela sincronizacao e entra no registro, entao passa a
            // constar tambem como "vindo do celular". Perguntando primeiro
            // pelo registro, ele nunca era reconhecido como ja publicado,
            // sobrava na lista de descartes e era apagado do banco -- e na
            // volta seguinte saia do projeto. Foi assim que tres louvores
            // sumiram do culto de 20/09.
            if (publicados.has(referencia)) {
                const publicado = publicados.get(referencia)!
                publicados.delete(referencia)
                // publicado antes de existir a marca de computador: assume
                // agora, senao ninguem poderia limpa-lo depois
                if (!publicado.de) escritas[`${caminho("cultos")}/${cultoId}/itens/${publicado.chave}/porComputador`] = meuId
                return
            }
            if (doRemote.has(referencia)) return

            escritas[`${caminho("cultos")}/${cultoId}/data`] = cultoId
            escritas[`${caminho("cultos")}/${cultoId}/itens/${chaveLocal(referencia)}`] = {
                nome: nomeDoItemLocal(entrada).slice(0, 60),
                tipo: "local",
                midia: entrada.type || "show",
                ref: referencia,
                // de qual computador saiu: so quem publicou pode apagar, senao
                // a maquina de casa limparia o que a da igreja montou
                porComputador: meuId,
                uid: usuario.uid,
                email: usuario.email || "",
                // a ordem do projeto vira a ordem no celular: a lista de la
                // e ordenada por este campo
                enviadoEm: Date.now() + ordem
            }
        })

        // sobrou publicado o que saiu do projeto aqui: tira do celular. O
        // que outro computador publicou fica -- de la ele nao saiu, e quem
        // apaga e quem montou
        publicados.forEach(({ chave, de }) => {
            if (de && de !== meuId) return
            escritas[`${caminho("cultos")}/${cultoId}/itens/${chave}`] = null
        })

        // O mesmo para o que veio do celular. Antes a remocao so andava num
        // sentido: tirar do culto aqui nao mudava nada la, e a
        // sincronizacao seguinte trazia o item de volta. So entra na conta
        // o que este computador viu entrar no projeto -- envio recem-feito,
        // ainda nao sincronizado, nao esta no mapa e nao corre risco.
        Object.entries(chavesPorRef[cultoId] || {}).forEach(([referencia, chave]) => {
            if (idsNoProjeto.has(referencia)) return
            escritas[`${caminho("cultos")}/${cultoId}/itens/${chave}`] = null
            delete chavesPorRef[cultoId][referencia]
        })
    }

    if (!Object.keys(escritas).length) return

    try {
        await update(ref(db!, "/"), escritas)
    } catch (erro) {
        console.error("Falha ao publicar o conteudo do projeto:", erro)
    }
}

function observarProjetos() {
    if (pararProjetos) return
    // o operador mexe no projeto o tempo todo; publicar a cada tecla seria
    // escrita a toa, e a sincronizacao em curso ja publica ao terminar
    pararProjetos = projects.subscribe(() => {
        if (!estado.ligado || sincronizando) return
        if (publicacaoAgendada) return
        publicacaoAgendada = setTimeout(() => {
            publicacaoAgendada = null
            publicarLocais(ultimaFotoCultos)
        }, 2000)
    })
}

function nomeDoArquivo(item: any) {
    const extensao = (String(item.arquivo || "").match(/\.[^.]+$/) || [""])[0].toLowerCase()
    const limpo = String(item.nome || "")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^A-Za-z0-9 ._-]/g, "")
        .trim()
    return limpo ? limpo + extensao : String(item.arquivo || "arquivo")
}

/** devolve true se tirou alguma linha repetida, mantendo sempre a primeira */
function tirarRepetidos(projetoId: string) {
    const projeto: any = get(projects)[projetoId]
    const itens: any[] = projeto?.shows || []
    if (!itens.length) return false

    const vistos = new Set<string>()
    const limpos = itens.filter((item) => {
        const id = String(item?.id || "")
        // So versiculo. Louvor repetido no culto costuma ser de proposito -- o
        // mesmo cantado na entrada e no final -- e foto repetida tambem; tirar
        // seria desfazer o que o operador montou. A duplicacao que esta funcao
        // conserta so acontecia ao remontar versiculo.
        if (!id.startsWith("bib-")) return true
        if (vistos.has(id)) return false
        vistos.add(id)
        return true
    })

    if (limpos.length === itens.length) return false

    projects.update((a) => {
        a[projetoId].shows = limpos
        return a
    })
    return true
}

/** devolve true se acrescentou; nunca duplica nem mexe no que o operador reordenou */
function adicionarAoProjeto(projetoId: string, ref: any, chave: string) {
    const projeto: any = get(projects)[projetoId]
    if (!projeto) return false
    if ((projeto.shows || []).some((s: any) => s.id === chave)) return false
    if (ref.type === "show" && !get(shows)[ref.id]) {
        // Musica escolhida no celular que nao existe nesta biblioteca. Antes
        // sumia calada: no celular parecia enviada, aqui nao acontecia nada, e
        // ninguem tinha como saber. Com o catalogo publicado por este mesmo
        // computador isso nao deveria mais ocorrer -- se ocorrer, o aviso diz
        // qual id faltou.
        console.warn("AliancaShow Remote: musica ignorada, nao existe nesta biblioteca:", ref.id)
        return false
    }

    projects.update((a) => {
        a[projetoId].shows = [...(a[projetoId].shows || []), ref]
        return a
    })
    return true
}
