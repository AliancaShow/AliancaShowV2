import { initializeApp, type FirebaseApp } from "firebase/app"
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, type Auth } from "firebase/auth"
import { getDatabase, onValue, ref, set, type Database } from "firebase/database"
import { get } from "svelte/store"
import { uid } from "uid"
import { Main } from "../../types/IPC/Main"
import { OutputHelper } from "../components/helpers/OutputHelper"
import { clearAll } from "../components/output/clear"
import { getActiveOutputs } from "../components/helpers/output"
import { getSlideText } from "../components/edit/scripts/textStyle"
import { activeProject, activeShow, outputs, outputDisplay, projects, shows, showsCache } from "../stores"
import { openProjectItem } from "../components/show/project"
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
        } else {
            pararOuvinte?.()
            pararOuvinte = null
            pararComandos?.()
            pararComandos = null
            pararEstado?.()
            pararEstado = null
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
        set(ref(db!, "estado"), novo).catch((erro) => console.error("Falha ao publicar o estado:", erro))
    }, 500)
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
let registroCarregado = false

async function carregarRegistro() {
    if (registroCarregado) return
    registroCarregado = true
    vindosDoRemote = (await requestMain(Main.GET_STORE_VALUE, { file: "config", key: "aliancaVindosDoRemote" })) || {}
}

function guardarRegistro() {
    sendMain(Main.SET_STORE_VALUE, { file: "config", key: "aliancaVindosDoRemote", value: vindosDoRemote })
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

async function sincronizar(cultos: { [id: string]: any }) {
    await carregarRegistro()

    let mudou = await garantirPastasDeMidia()
    mudou = garantirEstruturaCompleta() || mudou

    // o que o Remote pede AGORA, culto a culto -- a diferenca para o registro
    // anterior e exatamente o que alguem removeu pelo celular
    const pedidos: { [culto: string]: string[] } = {}
    const incompletos = new Set<string>()

    for (const [cultoId, culto] of Object.entries(cultos)) {
        const itens = Object.values((culto as any)?.itens || {}) as any[]
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

        for (const item of itens) {
            if (item.tipo === "musica") {
                daqui.push(item.showId)
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

            const tipoProjeto = item.tipo === "image" ? "image" : item.tipo === "video" ? "video" : "audio"
            if (adicionarAoProjeto(projetoId, { id: caminhoLocal, type: tipoProjeto, name: item.nome }, caminhoLocal)) {
                media.update((a) => {
                    if (!a[caminhoLocal]) a[caminhoLocal] = {}
                    return a
                })
                mudou = true
            }
        }
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

    const antes = JSON.stringify(vindosDoRemote)
    vindosDoRemote = pedidos
    if (JSON.stringify(pedidos) !== antes) guardarRegistro()

    if (mudou) {
        estado.ultimaSync = Date.now()
        avisar()
        setTimeout(() => save(), 1500)
    }
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
    if (ref.type === "show" && !get(shows)[ref.id]) return false // musica que nao existe neste computador

    projects.update((a) => {
        a[projetoId].shows = [...(a[projetoId].shows || []), ref]
        return a
    })
    return true
}
