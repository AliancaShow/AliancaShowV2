import { initializeApp, type FirebaseApp } from "firebase/app"
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, type Auth } from "firebase/auth"
import { getDatabase, onValue, ref, set, update, type Database } from "firebase/database"
import { get } from "svelte/store"
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

// as duas raizes, que viram pastas de projeto e tambem pastas de midia
const RAIZES = ["Alianca"]

export type EstadoRemote = { ligado: boolean; entrando: boolean; email: string; erro: string; ultimaSync: number; baixando: number }

let app: FirebaseApp | null = null
let auth: Auth | null = null
let db: Database | null = null
let pararOuvinte: (() => void) | null = null
let pararComandos: (() => void) | null = null
let pararEstado: (() => void) | null = null
let pararCatalogo: (() => void) | null = null
let pararBiblia: (() => void) | null = null
let pararProjetos: (() => void) | null = null
let aoMudarEstado: ((e: EstadoRemote) => void) | null = null

const estado: EstadoRemote = { ligado: false, entrando: false, email: "", erro: "", ultimaSync: 0, baixando: 0 }

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
            ouvirCultos()
            ouvirComandos()
            observarEstadoDaSaida()
            observarCatalogo()
            observarBiblia()
            observarProjetos()
        } else {
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
        }
    })
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
        } catch (e) {
            console.error("Falha ao sincronizar:", e)
        } finally {
            sincronizando = false
        }
    })()
}

function ouvirCultos() {
    if (!db || pararOuvinte) return

    pararOuvinte = onValue(
        ref(db, "cultos"),
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
        ref(db!, "comando"),
        (snap) => {
            const valor = snap.val()
            if (!valor?.acao) return

            // So obedece comando recente. onValue dispara com o que ja estava
            // no banco assim que conecta, entao um toque dado com o computador
            // desligado seria executado na abertura do app -- o slide pularia
            // sozinho no domingo de manha. Passado o prazo, limpa sem executar.
            const idade = Date.now() - (valor.em || 0)
            if (idade > VALIDADE_COMANDO) {
                set(ref(db!, "comando"), null).catch(() => {})
                return
            }

            const executar = COMANDOS[valor.acao]
            if (!executar) {
                console.warn("Comando remoto desconhecido:", valor.acao)
                return
            }

            executar(valor)

            // limpa para o mesmo toque nao repetir numa reconexao
            set(ref(db!, "comando"), null).catch((erro) => console.error("Falha ao limpar o comando:", erro))
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

function publicarEstado() {
    if (!db || !estado.ligado) return

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
        set(ref(db!, "estado"), novo).catch((erro) => {
            ultimoEstado = ""
            console.error("Falha ao publicar o estado:", erro)
        })
    }, 500)
}

/**
 * Publica a biblioteca de shows como catalogo, para o celular escolher musica.
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
    if (!db || !estado.ligado) return

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
    if (!db || !estado.ligado) return

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

    // ja existe: so referenciar
    if (get(shows)[showId]) return showId

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
            newData: { data: show, remember: { project: projetoId } },
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
    pararEstado = () => {
        a()
        b()
        c()
        d()
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

    let mudou = false
    for (const nome of RAIZES) {
        const caminho = `${raizOnline}\\${nome}`
        const jaTem = Object.values(get(mediaFolders)).some((f: any) => f.path === caminho)
        if (jaTem) continue

        mediaFolders.update((a) => {
            a[uid()] = { name: nome, path: caminho, icon: "folder", default: false }
            return a
        })
        mudou = true
    }
    return mudou
}

/** "2026-09-06" -> pastas Alianca/2026/09-setembro + projeto "06" */
const MESES = ["01-janeiro", "02-fevereiro", "03-marco", "04-abril", "05-maio", "06-junho", "07-julho", "08-agosto", "09-setembro", "10-outubro", "11-novembro", "12-dezembro"]
function caminhoDoculto(cultoId: string) {
    const data = cultoId.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (!data) return null
    return { pastas: ["Alianca", data[1], MESES[Number(data[2]) - 1]], projeto: data[3] }
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
function domingosDoMes(ano: number, mes: number) {
    const dias: string[] = []
    const d = new Date(ano, mes, 1)
    d.setDate(1 + ((7 - d.getDay()) % 7))
    while (d.getMonth() === mes) {
        dias.push(String(d.getDate()).padStart(2, "0"))
        d.setDate(d.getDate() + 7)
    }
    return dias
}

let pastasNoDiscoFeitas = false

function garantirEstruturaCompleta() {
    let mudou = false
    const ano = new Date().getFullYear()
    // um caminho por projeto: e o mesmo desenho que a pasta Online precisa ter
    const caminhos: string[] = []

    for (let mes = 0; mes < 12; mes++) {
        const { id: pastaMes, mudou: m1 } = garantirPastas(["Alianca", String(ano), MESES[mes]])
        mudou = mudou || m1
        for (const dia of domingosDoMes(ano, mes)) {
            const { mudou: m2 } = garantirProjeto(dia, pastaMes)
            mudou = mudou || m2
            caminhos.push(`Alianca/${ano}/${MESES[mes]}/${dia}`)
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
    if (!db || !estado.ligado) return fora

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
            escritas[`cultos/${cultoId}/itens/${chave}`] = null
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
    await carregarRegistro()

    let mudou = await garantirPastasDeMidia()
    mudou = garantirEstruturaCompleta() || mudou

    const removidosAqui = await apagarOsQueSairamDoProjeto()

    // o que o Remote pede AGORA, culto a culto -- a diferenca para o registro
    // anterior e exatamente o que alguem removeu pelo celular
    const pedidos: { [culto: string]: string[] } = {}
    const incompletos = new Set<string>()

    for (const [cultoId, culto] of Object.entries(cultos)) {
        const itens = Object.entries((culto as any)?.itens || {}).map(([chave, item]: any) => ({ ...item, chaveNoBanco: chave }))
        if (!itens.length) continue

        const partes = caminhoDoculto(cultoId)
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
        const anotar = (ref: string) => {
            if (ref) chaves[ref] = item.chaveNoBanco
        }

        for (const item of itens) {
            // acabou de sair do culto aqui: ja foi apagado do banco acima
            if (removidosAqui.has(`${cultoId}/${item.chaveNoBanco}`)) continue

            if (item.tipo === "biblia") {
                const showId = await criarShowDeVersiculo(item, projetoId)
                if (showId) {
                    daqui.push(showId)
                    anotar(showId)
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
                    anotar(item.ref)
                }
                continue
            }

            if (item.tipo === "musica") {
                daqui.push(item.showId)
                anotar(item.showId)
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
            anotar(caminhoLocal)

            const tipoProjeto = item.tipo === "image" ? "image" : item.tipo === "video" ? "video" : "audio"
            if (adicionarAoProjeto(projetoId, { id: caminhoLocal, type: tipoProjeto, name: item.nome }, caminhoLocal)) {
                media.update((a) => {
                    if (!a[caminhoLocal]) a[caminhoLocal] = {}
                    return a
                })
                mudou = true
            }
        }

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

    ultimaFotoCultos = cultos
    await publicarLocais(cultos)

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
    if (!db || !estado.ligado) return

    const usuario = auth?.currentUser
    if (!usuario) return

    await carregarRegistro()

    const escritas: { [caminho: string]: any } = {}
    const ano = new Date().getFullYear()

    for (let mes = 0; mes < 12; mes++) {
        for (const dia of domingosDoMes(ano, mes)) {
            const cultoId = `${ano}-${String(mes + 1).padStart(2, "0")}-${dia}`
            const partes = caminhoDoculto(cultoId)
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
            const publicados = new Map<string, string>()
            Object.entries(cultos[cultoId]?.itens || {}).forEach(([chave, item]: any) => {
                if (item?.tipo === "local" && item.ref) publicados.set(item.ref, chave)
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
                    publicados.delete(referencia)
                    return
                }
                if (doRemote.has(referencia)) return

                escritas[`cultos/${cultoId}/data`] = cultoId
                escritas[`cultos/${cultoId}/itens/${chaveLocal(referencia)}`] = {
                    nome: nomeDoItemLocal(entrada).slice(0, 60),
                    tipo: "local",
                    midia: entrada.type || "show",
                    ref: referencia,
                    uid: usuario.uid,
                    email: usuario.email || "",
                    // a ordem do projeto vira a ordem no celular: a lista de la
                    // e ordenada por este campo
                    enviadoEm: Date.now() + ordem
                }
            })

            // sobrou publicado o que saiu do projeto aqui: tira do celular
            publicados.forEach((chave) => {
                escritas[`cultos/${cultoId}/itens/${chave}`] = null
            })

            // O mesmo para o que veio do celular. Antes a remocao so andava num
            // sentido: tirar do culto aqui nao mudava nada la, e a
            // sincronizacao seguinte trazia o item de volta. So entra na conta
            // o que este computador viu entrar no projeto -- envio recem-feito,
            // ainda nao sincronizado, nao esta no mapa e nao corre risco.
            Object.entries(chavesPorRef[cultoId] || {}).forEach(([referencia, chave]) => {
                if (idsNoProjeto.has(referencia)) return
                escritas[`cultos/${cultoId}/itens/${chave}`] = null
                delete chavesPorRef[cultoId][referencia]
            })
        }
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
