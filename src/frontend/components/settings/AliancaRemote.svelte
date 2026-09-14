<script lang="ts">
    import { onMount } from "svelte"
    import { assumirControle, entrar, observarEstado, sair, type EstadoRemote } from "../../utils/aliancaRemote"
    import Icon from "../helpers/Icon.svelte"
    import MaterialButton from "../inputs/MaterialButton.svelte"
    import MaterialTextInput from "../inputs/MaterialTextInput.svelte"

    let estado: EstadoRemote = { ligado: false, entrando: false, email: "", erro: "", ultimaSync: 0, baixando: 0, principal: false, dono: "", agenda: "alianca" }
    let email = ""
    let senha = ""

    onMount(() => observarEstado((e) => (estado = e)))

    function quando(ms: number) {
        if (!ms) return ""
        const min = Math.round((Date.now() - ms) / 60000)
        if (min < 1) return "agora"
        if (min < 60) return `há ${min} min`
        return new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
    }
</script>

<div class="painel">
    <div class="topo">
        <span class="ponto" class:ligado={estado.ligado}></span>
        <div class="texto">
            <span class="titulo">AliançaShow Remote</span>
            <span class="detalhe">
                {#if estado.ligado}
                    {estado.email}
                    {#if estado.baixando}
                        · baixando {estado.baixando}
                    {:else if estado.ultimaSync}
                        · sincronizado {quando(estado.ultimaSync)}
                    {/if}
                {:else}
                    Desconectado
                {/if}
            </span>
        </div>
    </div>

    {#if estado.ligado}
        <p class="explicacao">
            As fotos, vídeos e músicas enviadas pelo celular chegam sozinhas. Os arquivos ficam na pasta <b>Online</b>, visíveis na aba Mídia, e cada
            culto vira um projeto com o mesmo caminho do envio.
        </p>

        <!-- Com mais de um computador, só um pode mandar no culto: se os dois
             publicassem, cada um apagaria o que o outro montou. Receber e baixar
             continua valendo para todos. -->
        <div class="papel">
            <Icon id={estado.principal ? "check" : "cloud"} size={0.9} white />
            <span>
                {#if estado.principal}
                    Este computador é o <b>principal</b> — é daqui que o celular recebe a ordem do culto.
                {:else if estado.dono}
                    O principal é <b>{estado.dono}</b>. Este aqui recebe e baixa tudo, mas não publica.
                {:else}
                    Nenhum computador assumiu ainda.
                {/if}
            </span>
        </div>

        {#if !estado.principal}
            <MaterialButton variant="outlined" icon="cloud" on:click={assumirControle} white>Tornar este o principal</MaterialButton>
        {/if}
        <MaterialButton variant="outlined" icon="logout" on:click={sair} white>Desconectar</MaterialButton>
    {:else}
        <p class="explicacao">Conecte a conta deste computador para receber o que a equipe enviar pelo celular.</p>

        <MaterialTextInput label="E-mail" value={email} on:change={(e) => (email = e.detail)} />
        <MaterialTextInput label="Senha" value={senha} type="password" on:change={(e) => (senha = e.detail)} />

        {#if estado.erro}
            <p class="erro"><Icon id="alert" size={0.9} white />{estado.erro}</p>
        {/if}

        <MaterialButton variant="contained" icon="cloud" disabled={estado.entrando || !email.trim() || !senha} on:click={() => entrar(email, senha)}>
            {estado.entrando ? "Conectando…" : "Conectar"}
        </MaterialButton>
    {/if}
</div>

<style>
    .painel {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 16px;
        margin-bottom: 20px;
        background-color: var(--primary-darker);
        border-radius: 8px;
    }

    .topo {
        display: flex;
        align-items: center;
        gap: 12px;
    }

    .papel {
        display: flex;
        align-items: flex-start;
        gap: 9px;
        padding: 11px 12px;
        border-radius: 6px;
        background-color: var(--primary);
        font-size: 0.9em;
        line-height: 1.5;
    }

    .ponto {
        flex-shrink: 0;
        width: 9px;
        height: 9px;
        border-radius: 50%;
        background-color: var(--disconnected);
    }
    .ponto.ligado {
        background-color: var(--connected);
    }

    .texto {
        display: flex;
        flex-direction: column;
        gap: 2px;
        overflow: hidden;
    }
    .titulo {
        font-weight: 600;
    }
    .detalhe {
        font-size: 0.8em;
        opacity: 0.6;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .explicacao {
        margin: 0;
        font-size: 0.85em;
        line-height: 1.55;
        opacity: 0.7;
    }

    .erro {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0;
        padding: 10px 12px;
        background-color: rgb(168 39 39 / 0.15);
        border-radius: 6px;
        font-size: 0.85em;
    }
</style>
