const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;

// ==========================================
// CONFIGURACOES DO SERVIDOR
// ==========================================
const PLAYER_TIMEOUT_MS = 30 * 1000;          // jogador some da sala apos 30s sem sync
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // token valido por 12 horas
const AUTH_WINDOW_MS = 60 * 1000;             // janela do anti-spam do /auth
const AUTH_MAX_ATTEMPTS = 10;                 // maximo de tentativas por IP/minuto

// ==========================================
// BANCO DE CHAVES
// personagens: [] = aceita qualquer personagem com essa key
// personagens: ["Nome"] = restringe a key aos nomes informados
// maxSessoes: 1 = uma sessao simultanea por key
// ==========================================
const chavesValidas = {
    "GUSTAVO-TESTE-123": {
        ativo: true,
        dono: "Voce",
        personagens: [],
        maxSessoes: 1
    },
    "CLIENTE-001-XYZ": {
        ativo: true,
        dono: "Joao da War",
        personagens: [],
        maxSessoes: 1
    },
    "DREAMNAV-777": {
        ativo: true,
        dono: "Membro da Quest",
        personagens: [],
        maxSessoes: 1
    }
};

// token -> { key, name, dono, createdAt, lastSeen, expiresAt }
const sessoes = new Map();

// token -> { name, room, timestamp }
const conectadosMap = new Map();

// ip -> { count, startedAt }
const authRateMap = new Map();

function responderJson(res, statusCode, payload) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache'
    });

    res.end(JSON.stringify(payload));
}

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];

    if (forwarded) {
        return String(forwarded).split(',')[0].trim();
    }

    return req.socket.remoteAddress || 'unknown';
}

function authPermitido(req) {
    const ip = getClientIp(req);
    const agora = Date.now();
    const atual = authRateMap.get(ip);

    if (!atual || agora - atual.startedAt >= AUTH_WINDOW_MS) {
        authRateMap.set(ip, {
            count: 1,
            startedAt: agora
        });

        return true;
    }

    if (atual.count >= AUTH_MAX_ATTEMPTS) {
        return false;
    }

    atual.count += 1;

    return true;
}

function normalizarNome(value) {
    if (typeof value !== 'string') {
        return '';
    }

    const nome = value.trim();

    if (!nome || nome.length > 50) {
        return '';
    }

    // Bloqueia caracteres de controle
    // Permite espacos, acentos, numeros etc.
    if (/[\x00-\x1F\x7F]/.test(nome)) {
        return '';
    }

    return nome;
}

function salaValida(value) {
    if (typeof value !== 'string') {
        return false;
    }

    return /^[A-Za-z0-9_-]{1,32}$/.test(value);
}

function personagemPermitido(registro, nome) {

    // Lista vazia = qualquer personagem
    if (
        !Array.isArray(registro.personagens) ||
        registro.personagens.length === 0
    ) {
        return true;
    }

    const alvo = nome.toLowerCase();

    return registro.personagens.some((personagem) => {
        return String(personagem)
            .trim()
            .toLowerCase() === alvo;
    });
}

function gerarToken() {
    return crypto
        .randomBytes(32)
        .toString('hex');
}

function apagarSessao(token) {
    sessoes.delete(token);
    conectadosMap.delete(token);
}

function validarSessao(token) {

    if (!token || typeof token !== 'string') {
        return null;
    }

    const sessao = sessoes.get(token);

    if (!sessao) {
        return null;
    }

    const agora = Date.now();

    // Token expirou
    if (agora >= sessao.expiresAt) {
        apagarSessao(token);
        return null;
    }

    // Verifica se a key ainda existe e esta ativa
    const registro = chavesValidas[sessao.key];

    if (!registro || !registro.ativo) {
        apagarSessao(token);
        return null;
    }

    return sessao;
}

function prepararNovaSessao(key, maxSessoes) {

    const existentes = [];

    for (const [token, sessao] of sessoes.entries()) {

        if (sessao.key !== key) {
            continue;
        }

        if (!validarSessao(token)) {
            continue;
        }

        existentes.push({
            token,
            sessao
        });
    }

    // Ordena da sessao mais antiga para a mais nova
    existentes.sort((a, b) => {
        return a.sessao.createdAt - b.sessao.createdAt;
    });

    // Se exceder o numero permitido,
    // remove a sessao mais antiga
    while (existentes.length >= maxSessoes) {

        const antiga = existentes.shift();

        apagarSessao(antiga.token);
    }
}

function limparExpirados() {

    const agora = Date.now();

    // Remove sessoes expiradas
    for (const token of Array.from(sessoes.keys())) {
        validarSessao(token);
    }

    // Remove jogadores offline
    for (const [token, data] of conectadosMap.entries()) {

        if (
            agora - data.timestamp > PLAYER_TIMEOUT_MS ||
            !validarSessao(token)
        ) {
            conectadosMap.delete(token);
        }
    }

    // Limpa registros antigos do anti-spam
    for (const [ip, data] of authRateMap.entries()) {

        if (
            agora - data.startedAt >
            AUTH_WINDOW_MS * 2
        ) {
            authRateMap.delete(ip);
        }
    }
}

// Executa limpeza automatica a cada 10 segundos
setInterval(
    limparExpirados,
    10 * 1000
).unref();

// ==========================================
// SERVIDOR HTTP
// ==========================================

const server = http.createServer((req, res) => {

    let urlObj;

    try {

        const host =
            req.headers.host ||
            `localhost:${PORT}`;

        urlObj = new URL(
            req.url,
            `http://${host}`
        );

    } catch (erro) {

        responderJson(res, 400, {
            ok: false,
            msg: 'Requisicao invalida.'
        });

        return;
    }

    // ==========================================
    // HEALTH CHECK
    //
    // /
    // /health
    // ==========================================

    if (
        urlObj.pathname === '/' ||
        urlObj.pathname === '/health'
    ) {

        responderJson(res, 200, {
            ok: true,
            service: 'guild-server',
            online: conectadosMap.size
        });

        return;
    }

    // ==========================================
    // AUTH
    //
    // VALIDA PRODUCT KEY
    // E GERA TOKEN TEMPORARIO
    //
    // Exemplo:
    //
    // /auth?key=GUSTAVO-TESTE-123&name=Gustavo
    // ==========================================

    if (urlObj.pathname === '/auth') {

        if (req.method !== 'GET') {

            responderJson(res, 405, {
                auth: false,
                msg: 'Metodo nao permitido.'
            });

            return;
        }

        // Anti-spam por IP
        if (!authPermitido(req)) {

            responderJson(res, 429, {
                auth: false,
                msg: 'Muitas tentativas. Aguarde um minuto.'
            });

            return;
        }

        const key =
            urlObj.searchParams.get('key') || '';

        const name =
            normalizarNome(
                urlObj.searchParams.get('name')
            );

        const registro =
            chavesValidas[key];

        // Key ou personagem nao enviado
        if (!key || !name) {

            responderJson(res, 400, {
                auth: false,
                msg: 'Key ou personagem nao informado.'
            });

            return;
        }

        // Key inexistente ou desativada
        if (!registro || !registro.ativo) {

            responderJson(res, 401, {
                auth: false,
                msg: 'Key invalida ou expirada.'
            });

            return;
        }

        // Verifica personagem autorizado
        if (
            !personagemPermitido(
                registro,
                name
            )
        ) {

            responderJson(res, 403, {
                auth: false,
                msg: 'Personagem nao autorizado para esta key.'
            });

            return;
        }

        // Numero maximo de sessoes permitidas
        const maxSessoes =
            Math.max(
                1,
                Number(registro.maxSessoes) || 1
            );

        prepararNovaSessao(
            key,
            maxSessoes
        );

        const agora =
            Date.now();

        const token =
            gerarToken();

        // Cria a sessao
        sessoes.set(token, {

            key,

            name,

            dono:
                registro.dono || '',

            createdAt:
                agora,

            lastSeen:
                agora,

            expiresAt:
                agora + SESSION_TTL_MS
        });

        responderJson(res, 200, {

            auth: true,

            msg:
                'Licenca valida! Bem vindo.',

            token,

            expiresIn:
                SESSION_TTL_MS
        });

        return;
    }

    // ==========================================
    // SYNC
    //
    // AGORA EXIGE TOKEN VALIDO
    //
    // Exemplo:
    //
    // /sync?token=TOKEN&room=1031&name=Gustavo
    // ==========================================

    if (urlObj.pathname === '/sync') {

        if (req.method !== 'GET') {

            responderJson(res, 405, {
                auth: false,
                msg: 'Metodo nao permitido.'
            });

            return;
        }

        const token =
            urlObj.searchParams.get('token') || '';

        const room =
            urlObj.searchParams.get('room') || '';

        const name =
            normalizarNome(
                urlObj.searchParams.get('name')
            );

        // Verifica o token
        const sessao =
            validarSessao(token);

        if (!sessao) {

            responderJson(res, 401, {
                auth: false,
                msg: 'Sessao invalida ou expirada.'
            });

            return;
        }

        // O personagem precisa ser o mesmo
        // usado na autenticacao
        if (
            !name ||
            name.toLowerCase() !==
            sessao.name.toLowerCase()
        ) {

            responderJson(res, 403, {
                auth: false,
                msg: 'Personagem nao corresponde a sessao.'
            });

            return;
        }

        // Verifica se a sala e valida
        if (!salaValida(room)) {

            responderJson(res, 400, {
                auth: false,
                msg: 'Canal invalido.'
            });

            return;
        }

        const agora =
            Date.now();

        // Atualiza a sessao
        sessao.lastSeen =
            agora;

        // Renova validade enquanto
        // o jogador estiver usando o bot
        sessao.expiresAt =
            agora + SESSION_TTL_MS;

        // Atualiza jogador online
        conectadosMap.set(token, {

            name:
                sessao.name,

            room,

            timestamp:
                agora
        });

        const membrosSet =
            new Set();

        // Procura os jogadores da mesma sala
        for (
            const [outroToken, data]
            of conectadosMap.entries()
        ) {

            // Remove jogador offline
            if (
                agora - data.timestamp >
                PLAYER_TIMEOUT_MS ||
                !validarSessao(outroToken)
            ) {

                conectadosMap.delete(
                    outroToken
                );

                continue;
            }

            // Mesma sala
            if (data.room === room) {

                membrosSet.add(
                    data.name
                );
            }
        }

        // Converte Set para Array
        const membrosDaSala =
            Array.from(membrosSet)
                .sort((a, b) =>
                    a.localeCompare(
                        b,
                        'pt-BR',
                        {
                            sensitivity: 'base'
                        }
                    )
                );

        responderJson(res, 200, {

            auth: true,

            room,

            members:
                membrosDaSala
        });

        return;
    }

    // ==========================================
    // ROTA NAO ENCONTRADA
    // ==========================================

    responderJson(res, 404, {
        ok: false,
        msg: 'Rota nao encontrada.'
    });
});

// ==========================================
// INICIA SERVIDOR
// ==========================================

server.listen(PORT, () => {

    console.log(
        `[Guild Server] Servidor HTTP rodando na porta ${PORT}`
    );

});
