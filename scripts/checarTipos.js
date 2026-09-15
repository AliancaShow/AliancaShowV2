/**
 * Portao de tipos antes de empacotar.
 *
 * O build do frontend e `vite build`: o esbuild apaga os tipos e nunca os
 * confere. Em 14/09/2026 uma variavel apagada por engano
 * (`pastasNoDiscoFeitas`) atravessou o build, o instalador e o dia inteiro --
 * a sincronizacao morria num ReferenceError e ninguem tinha como saber.
 *
 * O `tsc` pega isso. So que o FreeShow original carrega quase cem erros de
 * tipo antigos, entao exigir saida limpa pararia o build no primeiro minuto.
 * Aqui o corte e por CLASSE: barram-se os erros que viram falha em execucao --
 * nome que nao existe, nome usado antes de existir, nome declarado duas vezes
 * -- e o resto do ruido segue apenas listado no fim.
 */
const { execFileSync } = require("child_process")
const path = require("path")

// erros que o JavaScript so descobre na hora de rodar
const FATAIS = {
    TS2300: "nome declarado duas vezes",
    TS2304: "nome que nao existe",
    TS2448: "nome usado antes de existir",
    TS2454: "nome usado sem valor atribuido",
    TS2552: "nome que nao existe (parecido com outro)"
}

const PROJETOS = ["config/typescript/tsconfig.svelte.json", "config/typescript/tsconfig.electron.json"]

const TSC = require.resolve("typescript/bin/tsc")

function rodar(projeto) {
    try {
        execFileSync(process.execPath, [TSC, "--noEmit", "-p", projeto], { encoding: "utf8", stdio: "pipe" })
        return ""
    } catch (erro) {
        // tsc sai com codigo != 0 quando ha erro: a saida e o que interessa
        return String(erro.stdout || "") + String(erro.stderr || "")
    }
}

const linhas = []
for (const projeto of PROJETOS) {
    process.stdout.write(`checando tipos: ${path.basename(projeto)}... `)
    const saida = rodar(projeto)
    const daqui = saida.split("\n").filter((l) => l.startsWith("src/"))
    linhas.push(...daqui)
    console.log(`${daqui.length} apontamento(s)`)
}

const codigos = Object.keys(FATAIS).join("|")
const graves = linhas.filter((l) => new RegExp(`error (${codigos}):`).test(l))

if (graves.length) {
    console.error(`\nBUILD PARADO: ${graves.length} erro(s) que quebram em execucao.\n`)
    for (const l of graves) {
        const codigo = (l.match(/error (TS\d+):/) || [])[1]
        console.error(`  ${l.trim()}`)
        console.error(`     ^ ${FATAIS[codigo]}`)
    }
    console.error("\nNenhum destes sobrevive a execucao: corrija antes de empacotar.")
    process.exit(1)
}

console.log(`\nTipos: nenhum erro fatal. (${linhas.length} apontamento(s) antigos do FreeShow seguem ignorados.)`)
