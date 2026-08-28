const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;

const PLAYER_TIMEOUT_MS = 30 * 1000;
const LEADER_ACTIVE_TIMEOUT_MS = 5 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const AUTH_WINDOW_MS = 60 * 1000;
const AUTH_MAX_ATTEMPTS = 10;

// ==========================================
// PRODUCT KEYS
// permiteLeader: true = esta key pode usar a versao Leader.
// Use false para uma licenca vendida somente como Membro.
// personagens: [] = aceita qualquer personagem.
// ==========================================
const chavesValidas = {
    "GUSTAVO-TESTE-123": {
        ativo: true,
        dono: "Voce",
        personagens: [],
        maxSessoes: 1,
        permiteLeader: true
    },
    "CLIENTE-001-XYZ": {
        ativo: true,
        dono: "Joao da War",
        personagens: [],
        maxSessoes: 1,
        permiteLeader: true
    },
    "DREAMNAV-777": {
        ativo: true,
        dono: "Membro da Quest",
        personagens: [],
        maxSessoes: 1,
        permiteLeader: true
    }
};

// token -> sessao
const sessoes = new Map();

// token -> estado online do jogador
const conectadosMap = new Map();

// room -> Map(rank -> slot)
// slot = { token, name, rank, claimedAt, lastHeartbeat, alive, target }
const leaderRooms = new Map();

// ip -> rate limit auth
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

function normalizarTexto(value, max = 50, allowEmpty = false) {
    if (typeof value !== 'string') {
        return '';
    }

    const texto = value.trim();

    if (!texto) {
        return allowEmpty ? '' : '';
    }

    if (texto.length > max) {
        return '';
    }

    // Bloqueia caracteres de controle
    if (/[\x00-\x1F\x7F]/.test(texto)) {
        return '';
    }

    return texto;
}

function normalizarNome(value, max = 50) {
    return normalizarTexto(value, max, false);
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

function parseBoolean(value) {
    const raw = String(value || '')
        .trim()
        .toLowerCase();

    return (
        raw === '1' ||
        raw === 'true' ||
        raw === 'yes' ||
        raw === 'on'
    );
}

function parseLeaderRank(value) {
    const rank = Number(value);

    if (
        !Number.isInteger(rank) ||
        rank < 1 ||
        rank > 3
    ) {
        return 0;
    }

    return rank;
}

function personagemPermitido(registro, nome) {
    if (
        !Array.isArray(registro.personagens) ||
        registro.personagens.length === 0
    ) {
        return true;
    }

    const alvo = nome.toLowerCase();

    return registro.personagens.some((personagem) =>
        String(personagem)
            .trim()
            .toLowerCase() === alvo
    );
}

function gerarToken() {
    return crypto
        .randomBytes(32)
        .toString('hex');
}

function getLeaderMap(room, create = false) {
    let map = leaderRooms.get(room);

    if (!map && create) {
        map = new Map();
        leaderRooms.set(room, map);
    }

    return map || null;
}

function findLeaderSlotByToken(token) {
    for (const [room, map] of leaderRooms.entries()) {
        for (const [rank, slot] of map.entries()) {
            if (slot.token === token) {
                return {
                    room,
                    rank,
                    slot
                };
            }
        }
    }

    return null;
}

function releaseLeaderToken(
    token,
    exceptRoom = null,
    exceptRank = 0
) {
    for (const [room, map] of leaderRooms.entries()) {
        for (
            const [rank, slot]
            of Array.from(map.entries())
        ) {
            if (
                slot.token === token &&
                !(
                    room === exceptRoom &&
                    rank === exceptRank
                )
            ) {
                map.delete(rank);
            }
        }

        if (map.size === 0) {
            leaderRooms.delete(room);
        }
    }
}

function apagarSessao(token) {
    sessoes.delete(token);
    conectadosMap.delete(token);
    releaseLeaderToken(token);
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

    const registro =
        chavesValidas[sessao.key];

    if (!registro || !registro.ativo) {
        apagarSessao(token);
        return null;
    }

    return sessao;
}

function prepararNovaSessao(
    key,
    maxSessoes
) {
    const existentes = [];

    for (
        const [token, sessao]
        of sessoes.entries()
    ) {
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

    existentes.sort(
        (a, b) =>
            a.sessao.createdAt -
            b.sessao.createdAt
    );

    while (
        existentes.length >= maxSessoes
    ) {
        const antiga =
            existentes.shift();

        apagarSessao(
            antiga.token
        );
    }
}

function cleanupLeaderRooms(
    agora = Date.now()
) {
    for (
        const [room, map]
        of leaderRooms.entries()
    ) {
        for (
            const [rank, slot]
            of Array.from(map.entries())
        ) {
            const sessao =
                validarSessao(
                    slot.token
                );

            const expired =
                agora -
                    slot.lastHeartbeat >
                PLAYER_TIMEOUT_MS;

            if (!sessao || expired) {
                map.delete(rank);
            }
        }

        if (map.size === 0) {
            leaderRooms.delete(room);
        }
    }
}

function limparExpirados() {
    const agora = Date.now();

    for (
        const token
        of Array.from(sessoes.keys())
    ) {
        validarSessao(token);
    }

    for (
        const [token, data]
        of conectadosMap.entries()
    ) {
        if (
            agora - data.timestamp >
                PLAYER_TIMEOUT_MS ||
            !validarSessao(token)
        ) {
            conectadosMap.delete(token);
        }
    }

    cleanupLeaderRooms(agora);

    for (
        const [ip, data]
        of authRateMap.entries()
    ) {
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
// CONTROLE DE LEADER
// ==========================================

function processLeaderRequest({
    token,
    sessao,
    registro,
    room,
    requestedActive,
    requestedRank,
    alive,
    target,
    agora
}) {
    const previous =
        findLeaderSlotByToken(token);

    // ==========================================
    // DESLIGOU LEADER
    // ==========================================

    if (!requestedActive) {
        releaseLeaderToken(token);

        return {
            accepted: true,
            active: false,
            rank: 0,
            msg: 'Combo Leader OFF.'
        };
    }

    // ==========================================
    // LICENCA NAO PERMITE LEADER
    // ==========================================

    if (
        !registro ||
        registro.permiteLeader !== true
    ) {
        releaseLeaderToken(token);

        return {
            accepted: false,
            active: false,
            rank: 0,
            msg:
                'Sua licenca nao possui acesso ao Combo Leader.'
        };
    }

    // ==========================================
    // RANK INVALIDO
    // ==========================================

    if (
        requestedRank < 1 ||
        requestedRank > 3
    ) {
        return {
            accepted: false,
            active: Boolean(previous),
            rank:
                previous
                    ? previous.rank
                    : 0,
            msg:
                'Prioridade de Leader invalida.'
        };
    }

    const map =
        getLeaderMap(
            room,
            true
        );

    const occupied =
        map.get(
            requestedRank
        );

    // ==========================================
    // SLOT OCUPADO POR OUTRA PESSOA
    // ==========================================

    if (
        occupied &&
        occupied.token !== token
    ) {
        const occupiedSession =
            validarSessao(
                occupied.token
            );

        const slotExpired =
            agora -
                occupied.lastHeartbeat >
            PLAYER_TIMEOUT_MS;

        if (
            occupiedSession &&
            !slotExpired
        ) {
            return {
                accepted: false,
                active: Boolean(previous),

                rank:
                    previous
                        ? previous.rank
                        : 0,

                msg:
                    `Leader ${requestedRank} ja esta ocupado por ${occupied.name}.`,

                occupiedBy:
                    occupied.name
            };
        }

        map.delete(
            requestedRank
        );
    }

    // ==========================================
    // RESERVA O SLOT
    // ==========================================

    map.set(
        requestedRank,
        {
            token,

            name:
                sessao.name,

            rank:
                requestedRank,

            claimedAt:
                occupied &&
                occupied.token === token
                    ? occupied.claimedAt
                    : agora,

            lastHeartbeat:
                agora,

            alive:
                Boolean(alive),

            target:
                target || ''
        }
    );

    // Libera qualquer outro slot antigo
    // que esse mesmo token possuia.
    releaseLeaderToken(
        token,
        room,
        requestedRank
    );

    return {
        accepted: true,
        active: true,
        rank: requestedRank,

        msg:
            `Voce e o Leader ${requestedRank}.`
    };
}

function updateOwnedLeaderHeartbeat(
    token,
    room,
    alive,
    target,
    agora
) {
    const owned =
        findLeaderSlotByToken(
            token
        );

    if (
        !owned ||
        owned.room !== room
    ) {
        return;
    }

    owned.slot.lastHeartbeat =
        agora;

    owned.slot.alive =
        Boolean(alive);

    owned.slot.target =
        target || '';
}

function buildLeadersResponse(
    room,
    agora = Date.now()
) {
    cleanupLeaderRooms(
        agora
    );

    const map =
        getLeaderMap(
            room,
            false
        );

    const result = [];

    for (
        let rank = 1;
        rank <= 3;
        rank += 1
    ) {
        const slot =
            map
                ? map.get(rank)
                : null;

        // ==========================================
        // SLOT LIVRE
        // ==========================================

        if (!slot) {
            result.push({
                rank,
                occupied: false,
                name: '',
                alive: false,
                online: false,
                operational: false,
                target: ''
            });

            continue;
        }

        // ==========================================
        // LEADER ONLINE
        // ==========================================

        const online =
            agora -
                slot.lastHeartbeat <=
            LEADER_ACTIVE_TIMEOUT_MS;

        const alive =
            Boolean(
                slot.alive
            );

        result.push({
            rank,
            occupied: true,

            name:
                slot.name,

            alive,

            online,

            operational:
                online && alive,

            target:
                slot.target || ''
        });
    }

    return result;
}

// ==========================================
// SERVIDOR HTTP
// ==========================================

const server =
    http.createServer(
        (req, res) => {

    let urlObj;

    try {
        const host =
            req.headers.host ||
            `localhost:${PORT}`;

        urlObj =
            new URL(
                req.url,
                `http://${host}`
            );

    } catch {
        responderJson(
            res,
            400,
            {
                ok: false,
                msg:
                    'Requisicao invalida.'
            }
        );

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
        cleanupLeaderRooms();

        responderJson(
            res,
            200,
            {
                ok: true,

                service:
                    'guild-server-v4',

                online:
                    conectadosMap.size,

                sessions:
                    sessoes.size,

                leaderRooms:
                    leaderRooms.size
            }
        );

        return;
    }

    // ==========================================
    // AUTH
    //
    // /auth?key=XXX&name=Personagem
    // ==========================================

    if (
        urlObj.pathname === '/auth'
    ) {
        if (
            req.method !== 'GET'
        ) {
            responderJson(
                res,
                405,
                {
                    auth: false,
                    msg:
                        'Metodo nao permitido.'
                }
            );

            return;
        }

        // Anti-spam
        if (
            !authPermitido(req)
        ) {
            responderJson(
                res,
                429,
                {
                    auth: false,
                    msg:
                        'Muitas tentativas. Aguarde um minuto.'
                }
            );

            return;
        }

        const key =
            urlObj.searchParams.get(
                'key'
            ) || '';

        const name =
            normalizarNome(
                urlObj.searchParams.get(
                    'name'
                )
            );

        const registro =
            chavesValidas[key];

        // ==========================================
        // DADOS AUSENTES
        // ==========================================

        if (
            !key ||
            !name
        ) {
            responderJson(
                res,
                400,
                {
                    auth: false,
                    msg:
                        'Key ou personagem nao informado.'
                }
            );

            return;
        }

        // ==========================================
        // KEY INVALIDA
        // ==========================================

        if (
            !registro ||
            !registro.ativo
        ) {
            responderJson(
                res,
                401,
                {
                    auth: false,
                    msg:
                        'Key invalida ou expirada.'
                }
            );

            return;
        }

        // ==========================================
        // PERSONAGEM NAO PERMITIDO
        // ==========================================

        if (
            !personagemPermitido(
                registro,
                name
            )
        ) {
            responderJson(
                res,
                403,
                {
                    auth: false,
                    msg:
                        'Personagem nao autorizado para esta key.'
                }
            );

            return;
        }

        // ==========================================
        // LIMITE DE SESSOES
        // ==========================================

        const maxSessoes =
            Math.max(
                1,
                Number(
                    registro.maxSessoes
                ) || 1
            );

        prepararNovaSessao(
            key,
            maxSessoes
        );

        // ==========================================
        // CRIA TOKEN
        // ==========================================

        const agora =
            Date.now();

        const token =
            gerarToken();

        sessoes.set(
            token,
            {
                key,

                name,

                dono:
                    registro.dono || '',

                createdAt:
                    agora,

                lastSeen:
                    agora,

                expiresAt:
                    agora +
                    SESSION_TTL_MS
            }
        );

        responderJson(
            res,
            200,
            {
                auth: true,

                msg:
                    'Licenca valida! Bem vindo.',

                token,

                expiresIn:
                    SESSION_TTL_MS,

                leaderAllowed:
                    registro.permiteLeader === true
            }
        );

        return;
    }

    // ==========================================
    // SYNC
    // ==========================================

    if (
        urlObj.pathname === '/sync'
    ) {
        if (
            req.method !== 'GET'
        ) {
            responderJson(
                res,
                405,
                {
                    auth: false,
                    msg:
                        'Metodo nao permitido.'
                }
            );

            return;
        }

        // ==========================================
        // DADOS RECEBIDOS
        // ==========================================

        const token =
            urlObj.searchParams.get(
                'token'
            ) || '';

        const room =
            urlObj.searchParams.get(
                'room'
            ) ||
            urlObj.searchParams.get(
                'pass'
            ) ||
            '';

        const name =
            normalizarNome(
                urlObj.searchParams.get(
                    'name'
                )
            );

        const vocRaw =
            String(
                urlObj.searchParams.get(
                    'voc'
                ) || ''
            ).toUpperCase();

        const voc =
            vocacaoValida(vocRaw)
                ? vocRaw
                : '';

        const needsMana =
            parseBoolean(
                urlObj.searchParams.get(
                    'needsMana'
                )
            );

        const target =
            normalizarTexto(
                urlObj.searchParams.get(
                    'target'
                ) || '',
                50,
                true
            );

        const alive =
            parseBoolean(
                urlObj.searchParams.get(
                    'alive'
                )
            );

        const leaderRequested =
            parseBoolean(
                urlObj.searchParams.get(
                    'leaderActive'
                )
            );

        const leaderRank =
            parseLeaderRank(
                urlObj.searchParams.get(
                    'leaderRank'
                )
            );

        // ==========================================
        // VALIDA SESSAO
        // ==========================================

        const sessao =
            validarSessao(
                token
            );

        if (!sessao) {
            responderJson(
                res,
                401,
                {
                    auth: false,
                    msg:
                        'Sessao invalida ou expirada.'
                }
            );

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
            responderJson(
                res,
                403,
                {
                    auth: false,
                    msg:
                        'Personagem nao corresponde a sessao.'
                }
            );

            return;
        }

        // ==========================================
        // CONFERE CANAL
        // ==========================================

        if (
            !salaValida(room)
        ) {
            responderJson(
                res,
                400,
                {
                    auth: false,
                    msg:
                        'Canal invalido.'
                }
            );

            return;
        }

        const agora =
            Date.now();

        const registro =
            chavesValidas[
                sessao.key
            ];

        // ==========================================
        // RENOVA SESSAO
        // ==========================================

        sessao.lastSeen =
            agora;

        sessao.expiresAt =
            agora +
            SESSION_TTL_MS;

        // ==========================================
        // ATUALIZA PLAYER ONLINE
        // ==========================================

        conectadosMap.set(
            token,
            {
                name:
                    sessao.name,

                room,

                voc,

                needsMana,

                target,

                alive,

                timestamp:
                    agora
            }
        );

        // ==========================================
        // PROCESSA LEADER
        // ==========================================

        let myLeader;

        if (
            leaderRequested
        ) {
            myLeader =
                processLeaderRequest({
                    token,
                    sessao,
                    registro,
                    room,

                    requestedActive:
                        true,

                    requestedRank:
                        leaderRank,

                    alive,

                    target,

                    agora
                });

        } else {
            // Membro normal
            // ou Leader que desligou o botao.
            //
            // Libera imediatamente
            // qualquer vaga de Leader.

            myLeader =
                processLeaderRequest({
                    token,
                    sessao,
                    registro,
                    room,

                    requestedActive:
                        false,

                    requestedRank:
                        0,

                    alive,

                    target,

                    agora
                });
        }

        // ==========================================
        // HEARTBEAT DO LEADER
        // ==========================================

        updateOwnedLeaderHeartbeat(
            token,
            room,
            alive,
            target,
            agora
        );

        // ==========================================
        // JOGADORES DO MESMO CANAL
        // ==========================================

        const playersByName =
            new Map();

        for (
            const [
                outroToken,
                data
            ]
            of conectadosMap.entries()
        ) {
            if (
                agora -
                    data.timestamp >
                    PLAYER_TIMEOUT_MS ||
                !validarSessao(
                    outroToken
                )
            ) {
                conectadosMap.delete(
                    outroToken
                );

                continue;
            }

            if (
                data.room === room
            ) {
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
                            data.target || '',

                        alive:
                            Boolean(
                                data.alive
                            )
                    }
                );
            }
        }

        // ==========================================
        // ORDENA JOGADORES
        // ==========================================

        const players =
            Array
                .from(
                    playersByName.values()
                )
                .sort(
                    (a, b) =>
                        a.name.localeCompare(
                            b.name,
                            'pt-BR',
                            {
                                sensitivity:
                                    'base'
                            }
                        )
                );

        // ==========================================
        // RETORNA L1 / L2 / L3
        // ==========================================

        const leaders =
            buildLeadersResponse(
                room,
                agora
            );

        // ==========================================
        // RESPOSTA FINAL
        // ==========================================

        responderJson(
            res,
            200,
            {
                auth: true,

                room,

                members:
                    players.map(
                        (p) =>
                            p.name
                    ),

                players,

                leaders,

                myLeader
            }
        );

        return;
    }

    // ==========================================
    // ROTA NAO ENCONTRADA
    // ==========================================

    responderJson(
        res,
        404,
        {
            ok: false,
            msg:
                'Rota nao encontrada.'
        }
    );
});

// ==========================================
// INICIA SERVIDOR
// ==========================================

server.listen(
    PORT,
    () => {
        console.log(
            `[Guild Server V4] Servidor HTTP rodando na porta ${PORT}`
        );
    }
);
