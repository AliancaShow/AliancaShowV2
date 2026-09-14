<script lang="ts">
    /**
     * Faixa de cultos: a navegação entre projetos vira horizontal e some do
     * caminho, liberando toda a altura do painel para o conteúdo do culto.
     *
     * Motivo: escolher a data é um gesto por sessão; mexer nos itens é o
     * trabalho inteiro. Antes a lista de datas ocupava a coluna toda e o
     * conteúdo só aparecia depois de escolher — agora a data custa uma faixa e
     * o resto é conteúdo.
     *
     * O ponto embaixo de cada data diz se aquele culto já tem material. Era a
     * informação que faltava: com dezenas de projetos criados de antemão, não
     * havia como saber quais estão prontos sem abrir um por um.
     */
    import { onMount, tick } from "svelte"
    import type { Tree } from "../../../types/Projects"
    import { activeProject, projects, projectView } from "../../stores"
    import { openProject } from "./project"

    export let tree: Tree[] = []

    let faixaElem: HTMLDivElement | undefined

    // Só projetos: os cabeçalhos de grupo da lista contínua viram o rótulo
    // pequeno em cima de cada data, em vez de linha própria.
    $: cultos = montarCultos(tree)

    function montarCultos(itens: Tree[]) {
        const saida: { id: string; nome: string; grupo: string; mes: number; dia: number }[] = []
        let grupoAtual = ""
        let mesAtual = 0

        itens.forEach((item) => {
            if (item.type === "grupo") {
                grupoAtual = abreviar(item.name || "")
                // "09-setembro" -> 9, para saber qual culto esta mais perto de hoje
                mesAtual = Number((item.name || "").match(/^\d+/)?.[0] || 0)
                return
            }
            if (item.type === "folder") return

            // "07 Rede de Mulheres" -> dia 07 e nome proprio; nos cultos de data
            // fixa o nome do projeto e so o dia, e o rotulo segue sendo o mes
            const partes = (item.name || "").match(/^(\d{1,2})\s+(.+)$/)
            saida.push({
                id: item.id,
                nome: partes ? partes[1] : item.name || "—",
                grupo: partes ? partes[2] : grupoAtual,
                mes: mesAtual,
                dia: Number(partes ? partes[1] : item.name) || 0
            })
        })

        return saida
    }

    // "09-setembro" -> "SET". Nomes livres viram as três primeiras letras.
    function abreviar(nome: string) {
        const semNumero = nome.replace(/^\d+\s*[-_.]?\s*/, "")
        return semNumero.slice(0, 3).toUpperCase()
    }

    function contarItens(id: string) {
        return $projects[id]?.shows?.length || 0
    }

    function abrir(id: string) {
        if ($activeProject === id && !$projectView) return

        // openProject sai cedo quando o projeto ja e o ativo, e nesse caso nao
        // troca a visualizacao -- o painel continuaria na lista. Aqui a troca e
        // o ponto: apertar uma data mostra o conteudo dela.
        projectView.set(false)
        openProject(id)
    }

    // Mantém à vista o culto aberto -- ou, quando nenhum daqui está aberto, o
    // mais próximo de hoje. Trocar de agenda cai nesse caso: o culto que estava
    // aberto é da outra, e sem isto a faixa abria em janeiro.
    $: if (cultos.length && faixaElem) posicionar($activeProject)

    function posicionar(aberto: string | null) {
        const alvo = cultos.some((c) => c.id === aberto) ? aberto! : maisPerto()
        if (alvo) centralizar(alvo)
    }

    function maisPerto() {
        const hoje = new Date()
        const chaveHoje = (hoje.getMonth() + 1) * 100 + hoje.getDate()
        const proximo = cultos.find((c) => c.mes * 100 + c.dia >= chaveHoje)
        return (proximo || cultos[cultos.length - 1])?.id || ""
    }

    /**
     * Roda do mouse anda na horizontal aqui.
     *
     * A faixa rola de lado e a barra fica escondida, entao no computador nao
     * havia como chegar aos cultos fora da tela -- e num painel estreito isso e
     * quase todo o ano.
     */
    function rolar(e: WheelEvent) {
        if (!faixaElem || e.shiftKey) return
        const passo = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX
        if (!passo) return
        e.preventDefault()
        faixaElem.scrollLeft += passo
    }

    async function centralizar(id: string) {
        await tick()
        const alvo = faixaElem?.querySelector<HTMLElement>(`[data-id="${id}"]`)
        alvo?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" })
    }

    onMount(() => posicionar($activeProject))
</script>

{#if cultos.length}
    <div class="faixa" bind:this={faixaElem} role="tablist" aria-label="Cultos" on:wheel={rolar}>
        {#each cultos as culto (culto.id)}
            {@const itens = contarItens(culto.id)}
            {@const aberto = $activeProject === culto.id && !$projectView}
            <button class="culto" class:aberto class:cheio={itens > 0} class:nomeado={culto.grupo.length > 3} type="button" role="tab" aria-selected={aberto} data-id={culto.id} data-title="{culto.nome}{itens ? ` — ${itens} itens` : ''}" on:click={() => abrir(culto.id)}>
                {#if culto.grupo}<span class="grupo">{culto.grupo}</span>{/if}
                <span class="dia">{culto.nome}</span>
                <span class="pip"></span>
            </button>
        {/each}
    </div>
{/if}

<style>
    .faixa {
        display: flex;
        flex: none;
        gap: 5px;
        /* o cabecalho do painel e absoluto, 30px de altura, e flutua por cima:
           a faixa comeca abaixo dele para nao ficar encoberta */
        margin-top: 30px;
        padding: 10px 10px 12px;
        overflow-x: auto;
        scrollbar-width: none;
    }
    .faixa::-webkit-scrollbar {
        display: none;
    }

    .culto {
        flex: none;
        width: 50px;
        max-width: 110px;
        padding: 8px 0 9px;
        border: none;
        border-radius: 10px;
        background: rgb(255 255 255 / 0.06);
        color: inherit;
        cursor: pointer;
        display: grid;
        gap: 2px;
        justify-items: center;
        font-family: inherit;
        transition:
            background-color 120ms ease,
            box-shadow 120ms ease;
    }
    /* evento com nome proprio precisa de mais largura do que um dia */
    .culto.nomeado {
        width: auto;
        padding-inline: 8px;
    }
    .culto:hover {
        background: rgb(255 255 255 / 0.1);
    }
    .culto:focus-visible {
        outline: 2px solid var(--focus-ring, var(--secondary));
        outline-offset: 2px;
    }

    .grupo {
        max-width: 100%;
        font-family: var(--font-mono);
        font-size: 8px;
        letter-spacing: 0.12em;
        color: #6f7077;
        /* nome de evento e livre e pode ser longo; o dia abaixo nao pode sumir */
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .dia {
        font-family: var(--font-mono);
        font-size: 17px;
        font-weight: 500;
        line-height: 1.1;
        color: #c2c3c9;
        font-variant-numeric: tabular-nums;
    }

    /* preparado ou vazio, de relance */
    .pip {
        width: 4px;
        height: 4px;
        margin-top: 1px;
        border-radius: 50%;
        background: #6f7077;
        opacity: 0.45;
    }
    .culto.cheio .pip {
        background: #4ade80;
        opacity: 1;
    }

    .culto.aberto {
        background: rgb(242 26 39 / 0.16);
        box-shadow: inset 0 0 0 1px rgb(242 26 39 / 0.3);
    }
    .culto.aberto .dia {
        color: #ffffff;
    }
    .culto.aberto .grupo {
        color: #ff7f8b;
    }
</style>
