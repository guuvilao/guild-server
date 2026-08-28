const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;

const PLAYER_TIMEOUT_MS = 30 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const AUTH_WINDOW_MS = 60 * 1000;
const AUTH_MAX_ATTEMPTS = 10;

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

// token -> { name, room, voc, needsMana, target, timestamp }
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
        return String(forwarded)
            .split(',')[0]
            .trim();
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

function normalizarNome(value, max = 50) {
    if (typeof value !== 'string') {
        return '';
    }

    const texto = value.trim();

    if (!texto || texto.length > max) {
        return '';
    }

    if (/[^\P{C}\t]/u.test(texto)) {
        return '';
    }

    return texto;
}

function salaValida(value) {
    return (
        typeof value === 'string' &&
        /^[A-Za-z0-9_-]{1,32}$/.test(value)
    );
}

function vocacaoValida(value) {
    return ['EK', 'ED', 'MS', 'RP'].includes(value);
}

function personagemPermitido(registro, nome) {
    if (
        !Array.isArray(registro.personagens) ||
        registro.personagens.length === 0
    ) {
        return true;
    }

    const alvo = nome.toLowerCase();

    return registro.personagens.some((personagem) => {
        return (
            String(personagem)
                .trim()
                .toLowerCase() === alvo
        );
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

    if (agora >= sessao.expiresAt) {
        apagarSessao(token);
        return null;
    }

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

    existentes.sort((a, b) => {
        return a.sessao.createdAt - b.sessao.createdAt;
    });

    while (existentes.length >= maxSessoes) {
        const antiga = existentes.shift();

        apagarSessao(antiga.token);
    }
}

function limparExpirados() {
    const agora = Date.now();

    // Limpa sessoes expiradas
    for (const token of Array.from(sessoes.keys())) {
        validarSessao(token);
    }

    // Limpa jogadores offline
    for (const [token, data] of conectadosMap.entries()) {
        if (
            agora - data.timestamp > PLAYER_TIMEOUT_MS ||
            !validarSessao(token)
        ) {
            conectadosMap.delete(token);
        }
    }

    // Limpa IPs antigos do anti-spam
    for (const [ip, data] of authRateMap.entries()) {
        if (
            agora - data.startedAt >
            AUTH_WINDOW_MS * 2
        ) {
            authRateMap.delete(ip);
        }
    }
}

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

    } catch {
        responderJson(res, 400, {
            ok: false,
            msg: 'Requisicao invalida.'
        });

        return;
    }

    // ==========================================
    // HEALTH CHECK
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
            online: conectadosMap.size,
            sessions: sessoes.size
        });

        return;
    }

    // ==========================================
    // AUTH
    //
    // Exemplo:
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

        if (!key || !name) {
            responderJson(res, 400, {
                auth: false,
                msg: 'Key ou personagem nao informado.'
            });

            return;
        }

        if (!registro || !registro.ativo) {
            responderJson(res, 401, {
                auth: false,
                msg: 'Key invalida ou expirada.'
            });

            return;
        }

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

        sessoes.set(token, {
            key,
            name,
            dono: registro.dono || '',
            createdAt: agora,
            lastSeen: agora,
            expiresAt:
                agora + SESSION_TTL_MS
        });

        responderJson(res, 200, {
            auth: true,
            msg: 'Licenca valida! Bem vindo.',
            token,
            expiresIn: SESSION_TTL_MS
        });

        return;
    }

    // ==========================================
    // SYNC
    //
    // Exemplo:
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
            urlObj.searchParams.get('room') ||
            urlObj.searchParams.get('pass') ||
            '';

        const name =
            normalizarNome(
                urlObj.searchParams.get('name')
            );

        const vocRaw =
            String(
                urlObj.searchParams.get('voc') || ''
            ).toUpperCase();

        const voc =
            vocacaoValida(vocRaw)
                ? vocRaw
                : '';

        const needsManaRaw =
            String(
                urlObj.searchParams.get('needsMana') || ''
            ).toLowerCase();

        const needsMana =
            needsManaRaw === '1' ||
            needsManaRaw === 'true' ||
            needsManaRaw === 'yes';

        const target =
            normalizarNome(
                urlObj.searchParams.get('target') || '',
                50
            );

        // ==========================================
        // VALIDA TOKEN
        // ==========================================

        const sessao =
            validarSessao(token);

        if (!sessao) {
            responderJson(res, 401, {
                auth: false,
                msg: 'Sessao invalida ou expirada.'
            });

            return;
        }

        // ==========================================
        // CONFERE PERSONAGEM
        // ==========================================

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

        // ==========================================
        // CONFERE SALA
        // ==========================================

        if (!salaValida(room)) {
            responderJson(res, 400, {
                auth: false,
                msg: 'Canal invalido.'
            });

            return;
        }

        const agora =
            Date.now();

        // Renova sessao enquanto estiver usando
        sessao.lastSeen =
            agora;

        sessao.expiresAt =
            agora + SESSION_TTL_MS;

        // ==========================================
        // ATUALIZA JOGADOR ONLINE
        // ==========================================

        conectadosMap.set(token, {
            name: sessao.name,
            room,
            voc,
            needsMana,
            target,
            timestamp: agora
        });

        // ==========================================
        // LISTA DE JOGADORES DA SALA
        // ==========================================

        const playersByName =
            new Map();

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

            // Mesmo canal
            if (data.room === room) {
                playersByName.set(
                    data.name.toLowerCase(),
                    {
                        name:
                            data.name,

                        voc:
                            data.voc || '',

                        needsMana:
                            Boolean(
                                data.needsMana
                            ),

                        target:
                            data.target || ''
                    }
                );
            }
        }

        // ==========================================
        // ORDENA POR NOME
        // ==========================================

        const players =
            Array
                .from(
                    playersByName.values()
                )
                .sort((a, b) =>
                    a.name.localeCompare(
                        b.name,
                        'pt-BR',
                        {
                            sensitivity: 'base'
                        }
                    )
                );

        // ==========================================
        // RESPOSTA
        // ==========================================

        responderJson(res, 200, {
            auth: true,
            room,

            members:
                players.map(
                    (p) => p.name
                ),

            players
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
