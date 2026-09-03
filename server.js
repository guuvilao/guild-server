const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;

// ==========================================
// GUILD SERVER V7 / CLIENT V30
// Heartbeat completo separado do canal rapido de combate.
// ==========================================

const PLAYER_TIMEOUT_MS = 30 * 1000;
const LEADER_ACTIVE_TIMEOUT_MS = 5 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const AUTH_WINDOW_MS = 60 * 1000;
const AUTH_MAX_ATTEMPTS = 10;


// ==========================================
// PRODUCT KEYS
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


// ==========================================
// MEMORIA
// ==========================================

// token -> sessao
const sessoes = new Map();

// token -> player conectado pelo heartbeat
const conectadosMap = new Map();

// room -> Map(rank -> Leader)
const leaderRooms = new Map();

// room -> {
//     seq,
//     fingerprint
// }
const roomCombatVersions = new Map();

// IP -> anti spam
const authRateMap = new Map();


// ==========================================
// JSON
// ==========================================

function responderJson(
    res,
    statusCode,
    payload
) {

    res.writeHead(
        statusCode,
        {
            'Content-Type':
                'application/json; charset=utf-8',

            'Cache-Control':
                'no-store, no-cache, must-revalidate',

            'Pragma':
                'no-cache'
        }
    );

    res.end(
        JSON.stringify(payload)
    );

}


// ==========================================
// IP
// ==========================================

function getClientIp(req) {

    const forwarded =
        req.headers['x-forwarded-for'];

    if (forwarded) {

        return String(forwarded)
            .split(',')[0]
            .trim();

    }

    return (
        req.socket.remoteAddress ||
        'unknown'
    );

}


// ==========================================
// ANTI SPAM AUTH
// ==========================================

function authPermitido(req) {

    const ip =
        getClientIp(req);

    const agora =
        Date.now();

    const atual =
        authRateMap.get(ip);


    if (
        !atual ||
        agora - atual.startedAt >=
            AUTH_WINDOW_MS
    ) {

        authRateMap.set(
            ip,
            {
                count: 1,
                startedAt: agora
            }
        );

        return true;

    }


    if (
        atual.count >=
        AUTH_MAX_ATTEMPTS
    ) {

        return false;

    }


    atual.count += 1;

    return true;

}


// ==========================================
// TEXTO
// ==========================================

function normalizarTexto(
    value,
    max = 50,
    allowEmpty = false
) {

    if (
        typeof value !== 'string'
    ) {

        return '';

    }


    const texto =
        value.trim();


    if (!texto) {

        return allowEmpty
            ? ''
            : '';

    }


    if (
        texto.length > max
    ) {

        return '';

    }


    if (
        /[\x00-\x1F\x7F]/.test(texto)
    ) {

        return '';

    }


    return texto;

}


function normalizarNome(
    value,
    max = 50
) {

    return normalizarTexto(
        value,
        max,
        false
    );

}


// ==========================================
// SALA
// ==========================================

function salaValida(value) {

    return (
        typeof value === 'string' &&
        /^[A-Za-z0-9_-]{1,32}$/.test(
            value
        )
    );

}


// ==========================================
// VOCACAO
// ==========================================

function vocacaoValida(value) {

    return [
        'EK',
        'ED',
        'MS',
        'RP'
    ].includes(value);

}


// ==========================================
// BOOLEAN
// ==========================================

function parseBoolean(value) {

    const raw =
        String(
            value || ''
        )
        .trim()
        .toLowerCase();


    return (
        raw === '1' ||
        raw === 'true' ||
        raw === 'yes' ||
        raw === 'on'
    );

}


// ==========================================
// LEADER RANK
// ==========================================

function parseLeaderRank(value) {

    const rank =
        Number(value);


    if (
        Number.isInteger(rank) &&
        rank >= 1 &&
        rank <= 3
    ) {

        return rank;

    }


    return 0;

}


// ==========================================
// PVP / PVE / OFF
// ==========================================

function parseCombatMode(value) {

    const mode =
        String(
            value || 'OFF'
        )
        .trim()
        .toUpperCase();


    if (
        mode === 'PVP' ||
        mode === 'PVE'
    ) {

        return mode;

    }


    return 'OFF';

}


// ==========================================
// TARGET ID
// ==========================================

function parseTargetId(value) {

    const id =
        Number(
            value || 0
        );


    if (
        Number.isInteger(id) &&
        id > 0
    ) {

        return id;

    }


    return 0;

}


// ==========================================
// PERSONAGEM DA KEY
// ==========================================

function personagemPermitido(
    registro,
    nome
) {

    if (
        !Array.isArray(
            registro.personagens
        ) ||
        registro.personagens.length === 0
    ) {

        return true;

    }


    const alvo =
        nome.toLowerCase();


    return registro.personagens.some(
        (p) =>

            String(p)
                .trim()
                .toLowerCase()

            === alvo
    );

}


// ==========================================
// TOKEN
// ==========================================

function gerarToken() {

    return crypto
        .randomBytes(32)
        .toString('hex');

}


// ==========================================
// LEADER MAP
// ==========================================

function getLeaderMap(
    room,
    create = false
) {

    let map =
        leaderRooms.get(room);


    if (
        !map &&
        create
    ) {

        map =
            new Map();


        leaderRooms.set(
            room,
            map
        );

    }


    return map || null;

}


// ==========================================
// PROCURA LEADER PELO TOKEN
// ==========================================

function findLeaderSlotByToken(token) {

    for (
        const [room, map]
        of leaderRooms.entries()
    ) {

        for (
            const [rank, slot]
            of map.entries()
        ) {

            if (
                slot.token === token
            ) {

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


// ==========================================
// SEQUENCIA DE COMBATE
// ==========================================

function getRoomVersion(room) {

    let state =
        roomCombatVersions.get(
            room
        );


    if (!state) {

        state = {
            seq: 0,
            fingerprint: ''
        };


        roomCombatVersions.set(
            room,
            state
        );

    }


    return state;

}


// ==========================================
// MONTA L1 / L2 / L3
// ==========================================

function buildLeadersRaw(
    room,
    agora = Date.now()
) {

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


        if (!slot) {

            result.push({

                rank,

                occupied:
                    false,

                name:
                    '',

                alive:
                    false,

                online:
                    false,

                operational:
                    false,

                target:
                    '',

                targetId:
                    0,

                combatMode:
                    'OFF'

            });


            continue;

        }


        const online =

            agora -
                slot.lastHeartbeat

            <= LEADER_ACTIVE_TIMEOUT_MS;


        const alive =
            Boolean(
                slot.alive
            );


        result.push({

            rank,

            occupied:
                true,

            name:
                slot.name,

            alive,

            online,

            operational:
                online &&
                alive,

            target:
                slot.target || '',

            targetId:
                Number(
                    slot.targetId
                ) || 0,

            combatMode:
                parseCombatMode(
                    slot.combatMode
                )

        });

    }


    return result;

}


// ==========================================
// COMMANDER
// L1 -> L2 -> L3
// ==========================================

function buildCommanderFromLeaders(
    leaders
) {

    for (
        const leader
        of leaders
    ) {

        if (
            leader.occupied &&
            leader.operational
        ) {

            return {

                rank:
                    leader.rank,

                name:
                    leader.name,

                operational:
                    true,

                combatMode:
                    parseCombatMode(
                        leader.combatMode
                    ),

                target:
                    leader.target || '',

                targetId:
                    Number(
                        leader.targetId
                    ) || 0

            };

        }

    }


    return null;

}


// ==========================================
// ATUALIZA TARGET SEQ
// ==========================================

function refreshCombatVersion(
    room,
    agora = Date.now()
) {

    const leaders =
        buildLeadersRaw(
            room,
            agora
        );


    const commander =
        buildCommanderFromLeaders(
            leaders
        );


    const fingerprint =
        JSON.stringify({
            leaders,
            commander
        });


    const state =
        getRoomVersion(room);


    if (
        state.fingerprint !==
        fingerprint
    ) {

        state.seq += 1;

        state.fingerprint =
            fingerprint;

    }


    return {

        seq:
            state.seq,

        leaders,

        commander

    };

}


// ==========================================
// REMOVE LEADER
// ==========================================

function releaseLeaderToken(
    token,
    exceptRoom = null,
    exceptRank = 0
) {

    const touched =
        new Set();


    for (
        const [room, map]
        of leaderRooms.entries()
    ) {

        for (
            const [rank, slot]
            of Array.from(
                map.entries()
            )
        ) {

            if (

                slot.token === token &&

                !(
                    room === exceptRoom &&
                    rank === exceptRank
                )

            ) {

                map.delete(rank);

                touched.add(room);

            }

        }


        if (
            map.size === 0
        ) {

            leaderRooms.delete(
                room
            );

        }

    }


    const agora =
        Date.now();


    for (
        const room
        of touched
    ) {

        refreshCombatVersion(
            room,
            agora
        );

    }

}


// ==========================================
// APAGA SESSAO
// ==========================================

function apagarSessao(token) {

    sessoes.delete(
        token
    );

    conectadosMap.delete(
        token
    );

    releaseLeaderToken(
        token
    );

}


// ==========================================
// VALIDA SESSAO
// ==========================================

function validarSessao(token) {

    if (
        !token ||
        typeof token !== 'string'
    ) {

        return null;

    }


    const sessao =
        sessoes.get(token);


    if (!sessao) {

        return null;

    }


    const agora =
        Date.now();


    if (
        agora >=
        sessao.expiresAt
    ) {

        apagarSessao(
            token
        );

        return null;

    }


    const registro =
        chavesValidas[
            sessao.key
        ];


    if (
        !registro ||
        !registro.ativo
    ) {

        apagarSessao(
            token
        );

        return null;

    }


    return sessao;

}


// ==========================================
// MAX SESSOES
// ==========================================

function prepararNovaSessao(
    key,
    maxSessoes
) {

    const existentes = [];


    for (
        const [token, sessao]
        of sessoes.entries()
    ) {

        if (
            sessao.key !== key
        ) {

            continue;

        }


        if (
            !validarSessao(token)
        ) {

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
        existentes.length >=
        maxSessoes
    ) {

        const antiga =
            existentes.shift();


        apagarSessao(
            antiga.token
        );

    }

}


// ==========================================
// LIMPA LEADERS
// ==========================================

function cleanupLeaderRooms(
    agora = Date.now()
) {

    const touched =
        new Set();


    for (
        const [room, map]
        of leaderRooms.entries()
    ) {

        for (
            const [rank, slot]
            of Array.from(
                map.entries()
            )
        ) {

            const sessao =
                validarSessao(
                    slot.token
                );


            const expired =

                agora -
                    slot.lastHeartbeat

                > PLAYER_TIMEOUT_MS;


            if (
                !sessao ||
                expired
            ) {

                map.delete(
                    rank
                );

                touched.add(
                    room
                );

            }

        }


        if (
            map.size === 0
        ) {

            leaderRooms.delete(
                room
            );

        }

    }


    for (
        const room
        of touched
    ) {

        refreshCombatVersion(
            room,
            agora
        );

    }

}


// ==========================================
// SNAPSHOT RAPIDO
// ==========================================

function getCombatSnapshot(
    room,
    agora = Date.now()
) {

    cleanupLeaderRooms(
        agora
    );


    return refreshCombatVersion(
        room,
        agora
    );

}


// ==========================================
// PEDIDO DE LEADER
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

    targetId,

    combatMode,

    agora

}) {

    const previous =
        findLeaderSlotByToken(
            token
        );


    // ==========================================
    // LEADER OFF
    // ==========================================

    if (
        !requestedActive
    ) {

        releaseLeaderToken(
            token
        );


        return {

            accepted:
                true,

            active:
                false,

            rank:
                0,

            msg:
                'Combo Leader OFF.'

        };

    }


    // ==========================================
    // KEY SEM LEADER
    // ==========================================

    if (
        !registro ||
        registro.permiteLeader !== true
    ) {

        releaseLeaderToken(
            token
        );


        return {

            accepted:
                false,

            active:
                false,

            rank:
                0,

            msg:
                'Sua licenca nao possui acesso ao Combo Leader.'

        };

    }


    // ==========================================
    // RANK
    // ==========================================

    if (
        requestedRank < 1 ||
        requestedRank > 3
    ) {

        return {

            accepted:
                false,

            active:
                Boolean(
                    previous
                ),

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
    // SLOT OCUPADO
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
                occupied.lastHeartbeat

            > PLAYER_TIMEOUT_MS;


        if (
            occupiedSession &&
            !slotExpired
        ) {

            return {

                accepted:
                    false,

                active:
                    Boolean(
                        previous
                    ),

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
    // RESERVA SLOT
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
                Boolean(
                    alive
                ),

            target:
                target || '',

            targetId:
                parseTargetId(
                    targetId
                ),

            combatMode:
                parseCombatMode(
                    combatMode
                )

        }

    );


    // Um jogador so pode possuir um slot.

    releaseLeaderToken(
        token,
        room,
        requestedRank
    );


    refreshCombatVersion(
        room,
        agora
    );


    return {

        accepted:
            true,

        active:
            true,

        rank:
            requestedRank,

        msg:
            `Voce e o Leader ${requestedRank}.`

    };

}


// ==========================================
// HEARTBEAT NORMAL DO LEADER
// ==========================================

function updateOwnedLeaderHeartbeat(

    token,

    room,

    alive,

    target,

    targetId,

    combatMode,

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
        Boolean(
            alive
        );


    owned.slot.target =
        target || '';


    owned.slot.targetId =
        parseTargetId(
            targetId
        );


    owned.slot.combatMode =
        parseCombatMode(
            combatMode
        );


    refreshCombatVersion(
        room,
        agora
    );

}


// ==========================================
// FAST COMBAT UPDATE
//
// MUITO IMPORTANTE:
//
// Esta funcao NAO atualiza lastHeartbeat.
// Portanto o fast sync de combate NAO substitui
// o heartbeat completo de 1500ms.
// ==========================================

function updateOwnedLeaderCombat(

    token,

    room,

    alive,

    target,

    targetId,

    combatMode,

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

        return false;

    }


    owned.slot.alive =
        Boolean(
            alive
        );


    owned.slot.target =
        target || '';


    owned.slot.targetId =
        parseTargetId(
            targetId
        );


    owned.slot.combatMode =
        parseCombatMode(
            combatMode
        );


    refreshCombatVersion(
        room,
        agora
    );


    return true;

}


// ==========================================
// LIMPEZA
// ==========================================

function limparExpirados() {

    const agora =
        Date.now();


    // Sessoes

    for (
        const token
        of Array.from(
            sessoes.keys()
        )
    ) {

        validarSessao(
            token
        );

    }


    // Players

    for (
        const [token, data]
        of conectadosMap.entries()
    ) {

        if (

            agora -
                data.timestamp

            > PLAYER_TIMEOUT_MS ||

            !validarSessao(
                token
            )

        ) {

            conectadosMap.delete(
                token
            );

        }

    }


    // Leaders

    cleanupLeaderRooms(
        agora
    );


    // Anti spam

    for (
        const [ip, data]
        of authRateMap.entries()
    ) {

        if (

            agora -
                data.startedAt

            > AUTH_WINDOW_MS * 2

        ) {

            authRateMap.delete(
                ip
            );

        }

    }

}


setInterval(
    limparExpirados,
    10 * 1000
).unref();


// ==========================================
// VALIDA TOKEN + NOME + SALA
// ==========================================

function validarIdentidadeDeRequest(
    urlObj
) {

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


    const sessao =
        validarSessao(
            token
        );


    if (!sessao) {

        return {

            error: [
                401,
                {
                    auth: false,
                    msg:
                        'Sessao invalida ou expirada.'
                }
            ]

        };

    }


    if (

        !name ||

        name.toLowerCase() !==
            sessao.name.toLowerCase()

    ) {

        return {

            error: [
                403,
                {
                    auth: false,
                    msg:
                        'Personagem nao corresponde a sessao.'
                }
            ]

        };

    }


    if (
        !salaValida(room)
    ) {

        return {

            error: [
                400,
                {
                    auth: false,
                    msg:
                        'Canal invalido.'
                }
            ]

        };

    }


    return {
        token,
        room,
        name,
        sessao
    };

}


// ==========================================
// HTTP SERVER
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

                        ok:
                            false,

                        msg:
                            'Requisicao invalida.'

                    }

                );


                return;

            }


// ==========================================
// HEALTH
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

            ok:
                true,

            service:
                'guild-server-v7',

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

                auth:
                    false,

                msg:
                    'Metodo nao permitido.'

            }

        );


        return;

    }


    if (
        !authPermitido(req)
    ) {

        responderJson(

            res,

            429,

            {

                auth:
                    false,

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
        chavesValidas[
            key
        ];


    if (
        !key ||
        !name
    ) {

        responderJson(

            res,

            400,

            {

                auth:
                    false,

                msg:
                    'Key ou personagem nao informado.'

            }

        );


        return;

    }


    if (
        !registro ||
        !registro.ativo
    ) {

        responderJson(

            res,

            401,

            {

                auth:
                    false,

                msg:
                    'Key invalida ou expirada.'

            }

        );


        return;

    }


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

                auth:
                    false,

                msg:
                    'Personagem nao autorizado para esta key.'

            }

        );


        return;

    }


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

            auth:
                true,

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
// FAST COMBAT UPDATE
//
// SOMENTE LEADER
//
// Leader verifica target localmente em 50ms.
// Somente quando muda:
// /combat/update
// ==========================================

if (
    urlObj.pathname ===
    '/combat/update'
) {

    if (
        req.method !== 'GET'
    ) {

        responderJson(

            res,

            405,

            {

                auth:
                    false,

                msg:
                    'Metodo nao permitido.'

            }

        );


        return;

    }


    const ident =
        validarIdentidadeDeRequest(
            urlObj
        );


    if (
        ident.error
    ) {

        responderJson(

            res,

            ident.error[0],

            ident.error[1]

        );


        return;

    }


    const registro =

        chavesValidas[
            ident.sessao.key
        ];


    if (

        !registro ||

        registro.permiteLeader !== true

    ) {

        responderJson(

            res,

            403,

            {

                auth:
                    true,

                ok:
                    false,

                msg:
                    'Licenca sem acesso Leader.'

            }

        );


        return;

    }


    const owned =
        findLeaderSlotByToken(
            ident.token
        );


    if (

        !owned ||

        owned.room !== ident.room

    ) {

        responderJson(

            res,

            409,

            {

                auth:
                    true,

                ok:
                    false,

                msg:
                    'Nenhum slot de Leader ativo nesta sala.'

            }

        );


        return;

    }


    const target =

        normalizarTexto(

            urlObj.searchParams.get(
                'target'
            ) || '',

            50,

            true

        );


    const targetId =

        parseTargetId(

            urlObj.searchParams.get(
                'targetId'
            )

        );


    const alive =

        parseBoolean(

            urlObj.searchParams.get(
                'alive'
            )

        );


    const combatMode =

        parseCombatMode(

            urlObj.searchParams.get(
                'combatMode'
            )

        );


    const agora =
        Date.now();


    updateOwnedLeaderCombat(

        ident.token,

        ident.room,

        alive,

        target,

        targetId,

        combatMode,

        agora

    );


    const snapshot =
        getCombatSnapshot(
            ident.room,
            agora
        );


    responderJson(

        res,

        200,

        {

            auth:
                true,

            ok:
                true,

            changed:
                true,

            seq:
                snapshot.seq,

            leaders:
                snapshot.leaders,

            commander:
                snapshot.commander

        }

    );


    return;

}


// ==========================================
// FAST COMBAT STATE
//
// MEMBROS
//
// Exemplo:
// /combat/state?seq=25
//
// Se ainda for 25:
// resposta muito pequena.
//
// Se mudou para 26:
// envia novo target / commander.
// ==========================================

if (
    urlObj.pathname ===
    '/combat/state'
) {

    if (
        req.method !== 'GET'
    ) {

        responderJson(

            res,

            405,

            {

                auth:
                    false,

                msg:
                    'Metodo nao permitido.'

            }

        );


        return;

    }


    const ident =
        validarIdentidadeDeRequest(
            urlObj
        );


    if (
        ident.error
    ) {

        responderJson(

            res,

            ident.error[0],

            ident.error[1]

        );


        return;

    }


    const since =

        Math.max(

            0,

            Number(

                urlObj.searchParams.get(
                    'seq'
                )

            ) || 0

        );


    const snapshot =
        getCombatSnapshot(

            ident.room,

            Date.now()

        );


    // Nada mudou.

    if (
        since >=
        snapshot.seq
    ) {

        responderJson(

            res,

            200,

            {

                auth:
                    true,

                changed:
                    false,

                seq:
                    snapshot.seq

            }

        );


        return;

    }


    // Combate mudou.

    responderJson(

        res,

        200,

        {

            auth:
                true,

            changed:
                true,

            seq:
                snapshot.seq,

            leaders:
                snapshot.leaders,

            commander:
                snapshot.commander

        }

    );


    return;

}


// ==========================================
// HEARTBEAT COMPLETO
//
// Continua rodando aproximadamente
// a cada 1500ms.
//
// Nao e mais responsavel sozinho
// pela velocidade de troca de target.
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

                auth:
                    false,

                msg:
                    'Metodo nao permitido.'

            }

        );


        return;

    }


    const ident =
        validarIdentidadeDeRequest(
            urlObj
        );


    if (
        ident.error
    ) {

        responderJson(

            res,

            ident.error[0],

            ident.error[1]

        );


        return;

    }


    // ==========================================
    // DADOS DO PLAYER
    // ==========================================

    const vocRaw =

        String(

            urlObj.searchParams.get(
                'voc'
            ) || ''

        ).toUpperCase();


    const voc =

        vocacaoValida(
            vocRaw
        )

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


    const targetId =

        parseTargetId(

            urlObj.searchParams.get(
                'targetId'
            )

        );


    const alive =

        parseBoolean(

            urlObj.searchParams.get(
                'alive'
            )

        );


    const combatMode =

        parseCombatMode(

            urlObj.searchParams.get(
                'combatMode'
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


    const agora =
        Date.now();


    const registro =

        chavesValidas[
            ident.sessao.key
        ];


    // ==========================================
    // RENOVA SESSAO
    // ==========================================

    ident.sessao.lastSeen =
        agora;


    ident.sessao.expiresAt =

        agora +

        SESSION_TTL_MS;


    // ==========================================
    // PLAYER ONLINE
    // ==========================================

    conectadosMap.set(

        ident.token,

        {

            name:
                ident.sessao.name,

            room:
                ident.room,

            voc,

            needsMana,

            target,

            targetId,

            combatMode,

            alive,

            timestamp:
                agora

        }

    );


    // ==========================================
    // LEADER
    // ==========================================

    const myLeader =

        processLeaderRequest({

            token:
                ident.token,

            sessao:
                ident.sessao,

            registro,

            room:
                ident.room,

            requestedActive:
                leaderRequested,

            requestedRank:

                leaderRequested

                    ? leaderRank

                    : 0,

            alive,

            target,

            targetId,

            combatMode,

            agora

        });


    // Heartbeat operacional
    // continua separado do fast combat.

    updateOwnedLeaderHeartbeat(

        ident.token,

        ident.room,

        alive,

        target,

        targetId,

        combatMode,

        agora

    );


    // ==========================================
    // PLAYERS DA SALA
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
                data.timestamp

            > PLAYER_TIMEOUT_MS ||

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
            data.room ===
            ident.room
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

                    targetId:
                        Number(
                            data.targetId
                        ) || 0,

                    combatMode:
                        parseCombatMode(
                            data.combatMode
                        ),

                    alive:
                        Boolean(
                            data.alive
                        )

                }

            );

        }

    }


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
    // COMBAT SNAPSHOT
    // ==========================================

    const snapshot =
        getCombatSnapshot(
            ident.room,
            agora
        );


    // ==========================================
    // RESPOSTA
    // ==========================================

    responderJson(

        res,

        200,

        {

            auth:
                true,

            room:
                ident.room,

            members:

                players.map(
                    (p) => p.name
                ),

            players,

            leaders:
                snapshot.leaders,

            commander:
                snapshot.commander,

            combatSeq:
                snapshot.seq,

            myLeader

        }

    );


    return;

}


// ==========================================
// 404
// ==========================================

responderJson(

    res,

    404,

    {

        ok:
            false,

        msg:
            'Rota nao encontrada.'

    }

);

        }

    );


// ==========================================
// START
// ==========================================

server.listen(

    PORT,

    () => {

        console.log(

            `[Guild Server V7] Servidor HTTP rodando na porta ${PORT}`

        );

    }

);
