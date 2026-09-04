const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;

const PLAYER_TIMEOUT_MS = 30_000;
const LEADER_ACTIVE_TIMEOUT_MS = 5_000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const AUTH_WINDOW_MS = 60_000;
const AUTH_MAX_ATTEMPTS = 10;


// ==========================================
// GUILD SERVER V8 / CLIENT V31
//
// /sync
// = heartbeat geral
//
// /combat/update
// = mudanca rapida do Leader
//
// /combat/state
// = leitura rapida dos membros
// ==========================================


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

const sessoes = new Map();

const conectadosMap = new Map();

const leaderRooms = new Map();

const roomCombatVersions = new Map();

const authRateMap = new Map();


// ==========================================
// JSON
// ==========================================

function responderJson(
    res,
    status,
    body
) {

    res.writeHead(
        status,
        {

            'Content-Type':
                'application/json; charset=utf-8',

            'Cache-Control':
                'no-store, no-cache, must-revalidate',

            Pragma:
                'no-cache'

        }
    );


    res.end(
        JSON.stringify(body)
    );

}


// ==========================================
// IP
// ==========================================

function getClientIp(req) {

    const forwarded =
        req.headers[
            'x-forwarded-for'
        ];


    return forwarded

        ? String(forwarded)
            .split(',')[0]
            .trim()

        : (
            req.socket.remoteAddress ||
            'unknown'
        );

}


// ==========================================
// RATE LIMIT AUTH
// ==========================================

function authPermitido(req) {

    const ip =
        getClientIp(req);


    const agora =
        Date.now();


    const state =
        authRateMap.get(ip);


    if (

        !state ||

        agora -
            state.startedAt >=
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
        state.count >=
        AUTH_MAX_ATTEMPTS
    ) {

        return false;

    }


    state.count += 1;


    return true;

}


// ==========================================
// TEXTO
// ==========================================

function normalizarTexto(
    value,
    max = 50
) {

    if (
        typeof value !==
        'string'
    ) {

        return '';

    }


    const text =
        value.trim();


    if (
        text.length > max
    ) {

        return '';

    }


    if (
        /[\x00-\x1F\x7F]/.test(
            text
        )
    ) {

        return '';

    }


    return text;

}


function normalizarNome(
    value
) {

    return normalizarTexto(
        value,
        50
    );

}


// ==========================================
// SALA
// ==========================================

function salaValida(
    value
) {

    return (

        typeof value ===
            'string' &&

        /^[A-Za-z0-9_-]{1,32}$/
            .test(value)

    );

}


// ==========================================
// VOCACAO
// ==========================================

function vocacaoValida(
    value
) {

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

function parseBoolean(
    value
) {

    return [

        '1',
        'true',
        'yes',
        'on'

    ].includes(

        String(
            value || ''
        )
        .trim()
        .toLowerCase()

    );

}


// ==========================================
// LEADER RANK
// ==========================================

function parseLeaderRank(
    value
) {

    const n =
        Number(value);


    return (

        Number.isInteger(n) &&

        n >= 1 &&

        n <= 3

    )
        ? n
        : 0;

}


// ==========================================
// COMBAT MODE
// ==========================================

function parseCombatMode(
    value
) {

    const mode =

        String(
            value || 'OFF'
        )
        .trim()
        .toUpperCase();


    return (

        mode === 'PVP' ||

        mode === 'PVE'

    )
        ? mode
        : 'OFF';

}


// ==========================================
// TARGET ID
// ==========================================

function parseTargetId(
    value
) {

    const id =
        Number(
            value || 0
        );


    return (

        Number.isInteger(id) &&

        id > 0

    )
        ? id
        : 0;

}


// ==========================================
// PERSONAGEM
// ==========================================

function personagemPermitido(
    registro,
    nome
) {

    if (

        !Array.isArray(
            registro.personagens
        ) ||

        registro.personagens.length ===
            0

    ) {

        return true;

    }


    const wanted =
        nome.toLowerCase();


    return registro.personagens.some(

        p =>

            String(p)
                .trim()
                .toLowerCase()

            === wanted

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
        leaderRooms.get(
            room
        );


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
// PROCURA SLOT
// ==========================================

function findLeaderSlotByToken(
    token
) {

    for (
        const [room, map]
        of leaderRooms
    ) {

        for (
            const [rank, slot]
            of map
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
// SEQUENCIA DA SALA
// ==========================================

function getRoomVersion(
    room
) {

    let state =
        roomCombatVersions.get(
            room
        );


    if (!state) {

        state = {

            seq:
                0,

            fingerprint:
                ''

        };


        roomCombatVersions.set(
            room,
            state
        );

    }


    return state;

}


// ==========================================
// LEADERS
// ==========================================

function buildLeaders(
    room,
    agora = Date.now()
) {

    const map =
        getLeaderMap(
            room,
            false
        );


    const leaders = [];


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

            leaders.push({

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

            <=
            LEADER_ACTIVE_TIMEOUT_MS;


        const alive =
            Boolean(
                slot.alive
            );


        leaders.push({

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


    return leaders;

}


// ==========================================
// COMMANDER
// ==========================================

function buildCommander(
    leaders
) {

    const leader =

        leaders.find(

            x =>

                x.occupied &&

                x.operational

        );


    if (!leader) {

        return null;

    }


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


// ==========================================
// COMBAT SEQ
// ==========================================

function refreshCombatVersion(
    room,
    agora = Date.now()
) {

    const leaders =
        buildLeaders(
            room,
            agora
        );


    const commander =
        buildCommander(
            leaders
        );


    const fingerprint =

        JSON.stringify({

            leaders,

            commander

        });


    const state =
        getRoomVersion(
            room
        );


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
// LIBERA LEADER
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
        of leaderRooms
    ) {

        for (
            const [rank, slot]
            of Array.from(
                map.entries()
            )
        ) {

            if (

                slot.token ===
                    token &&

                !(
                    room ===
                        exceptRoom &&

                    rank ===
                        exceptRank
                )

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

function apagarSessao(
    token
) {

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

function validarSessao(
    token
) {

    if (

        !token ||

        typeof token !==
            'string'

    ) {

        return null;

    }


    const sessao =
        sessoes.get(
            token
        );


    if (!sessao) {

        return null;

    }


    const agora =
        Date.now();


    const registro =

        chavesValidas[
            sessao.key
        ];


    if (

        agora >=
            sessao.expiresAt ||

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

    const existentes =
        [];


    for (
        const [token, sessao]
        of sessoes
    ) {

        if (

            sessao.key === key &&

            validarSessao(
                token
            )

        ) {

            existentes.push({

                token,

                sessao

            });

        }

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

        apagarSessao(

            existentes
                .shift()
                .token

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
        of leaderRooms
    ) {

        for (
            const [rank, slot]
            of Array.from(
                map.entries()
            )
        ) {

            const expired =

                agora -
                    slot.lastHeartbeat

                >
                PLAYER_TIMEOUT_MS;


            if (

                !validarSessao(
                    slot.token
                ) ||

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
// SNAPSHOT
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
// PROCESSA LEADER
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


    if (

        !registro ||

        registro.permiteLeader !==
            true

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


    if (

        occupied &&

        occupied.token !==
            token

    ) {

        const valid =

            validarSessao(
                occupied.token
            );


        const expired =

            agora -
                occupied.lastHeartbeat

            >
            PLAYER_TIMEOUT_MS;


        if (
            valid &&
            !expired
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
    // V31
    //
    // Se ja somos donos deste slot,
    // /sync vira SOMENTE heartbeat.
    //
    // Ele NAO sobrescreve:
    // target
    // targetId
    // combatMode
    // alive
    // ==========================================

    if (

        occupied &&

        occupied.token ===
            token

    ) {

        occupied.name =
            sessao.name;


        occupied.lastHeartbeat =
            agora;


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


    // Novo slot

    map.set(

        requestedRank,

        {

            token,

            name:
                sessao.name,

            rank:
                requestedRank,

            claimedAt:
                agora,

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
// HEARTBEAT DO LEADER
//
// NAO TOCA NO COMBATE
// ==========================================

function updateOwnedLeaderHeartbeat(
    token,
    room,
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


    owned.slot.lastHeartbeat =
        agora;


    refreshCombatVersion(
        room,
        agora
    );


    return true;

}


// ==========================================
// FAST COMBAT
//
// UNICO CAMINHO QUE ALTERA:
//
// target
// targetId
// combatMode
// alive
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


    owned.slot.lastCombatAt =
        agora;


    refreshCombatVersion(
        room,
        agora
    );


    return true;

}


// ==========================================
// LIMPEZA GERAL
// ==========================================

function limparExpirados() {

    const agora =
        Date.now();


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


    for (
        const [token, data]
        of conectadosMap
    ) {

        if (

            agora -
                data.timestamp

            >
            PLAYER_TIMEOUT_MS ||

            !validarSessao(
                token
            )

        ) {

            conectadosMap.delete(
                token
            );

        }

    }


    cleanupLeaderRooms(
        agora
    );


    for (
        const [ip, state]
        of authRateMap
    ) {

        if (

            agora -
                state.startedAt

            >
            AUTH_WINDOW_MS * 2

        ) {

            authRateMap.delete(
                ip
            );

        }

    }

}


setInterval(
    limparExpirados,
    10_000
).unref();


// ==========================================
// IDENTIDADE
// ==========================================

function validarIdentidade(
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

                    auth:
                        false,

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

                    auth:
                        false,

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

                    auth:
                        false,

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
// HTTP
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


                return responderJson(

                    res,

                    400,

                    {

                        ok:
                            false,

                        msg:
                            'Requisicao invalida.'

                    }

                );

            }


            // ==========================================
            // HEALTH
            // ==========================================

            if (

                urlObj.pathname === '/' ||

                urlObj.pathname === '/health'

            ) {

                cleanupLeaderRooms();


                return responderJson(

                    res,

                    200,

                    {

                        ok:
                            true,

                        service:
                            'guild-server-v8',

                        online:
                            conectadosMap.size,

                        sessions:
                            sessoes.size,

                        leaderRooms:
                            leaderRooms.size

                    }

                );

            }


            // ==========================================
            // AUTH
            // ==========================================

            if (
                urlObj.pathname ===
                '/auth'
            ) {

                if (
                    req.method !==
                    'GET'
                ) {

                    return responderJson(

                        res,

                        405,

                        {

                            auth:
                                false,

                            msg:
                                'Metodo nao permitido.'

                        }

                    );

                }


                if (
                    !authPermitido(req)
                ) {

                    return responderJson(

                        res,

                        429,

                        {

                            auth:
                                false,

                            msg:
                                'Muitas tentativas. Aguarde um minuto.'

                        }

                    );

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

                    return responderJson(

                        res,

                        400,

                        {

                            auth:
                                false,

                            msg:
                                'Key ou personagem nao informado.'

                        }

                    );

                }


                if (

                    !registro ||

                    !registro.ativo

                ) {

                    return responderJson(

                        res,

                        401,

                        {

                            auth:
                                false,

                            msg:
                                'Key invalida ou expirada.'

                        }

                    );

                }


                if (

                    !personagemPermitido(
                        registro,
                        name
                    )

                ) {

                    return responderJson(

                        res,

                        403,

                        {

                            auth:
                                false,

                            msg:
                                'Personagem nao autorizado para esta key.'

                        }

                    );

                }


                prepararNovaSessao(

                    key,

                    Math.max(

                        1,

                        Number(
                            registro.maxSessoes
                        ) || 1

                    )

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


                return responderJson(

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

                            registro.permiteLeader ===
                            true

                    }

                );

            }


            // ==========================================
            // FAST UPDATE
            // ==========================================

            if (
                urlObj.pathname ===
                '/combat/update'
            ) {

                if (
                    req.method !==
                    'GET'
                ) {

                    return responderJson(

                        res,

                        405,

                        {

                            auth:
                                false,

                            msg:
                                'Metodo nao permitido.'

                        }

                    );

                }


                const ident =
                    validarIdentidade(
                        urlObj
                    );


                if (
                    ident.error
                ) {

                    return responderJson(

                        res,

                        ident.error[0],

                        ident.error[1]

                    );

                }


                const registro =

                    chavesValidas[
                        ident.sessao.key
                    ];


                if (

                    !registro ||

                    registro.permiteLeader !==
                        true

                ) {

                    return responderJson(

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

                }


                const owned =

                    findLeaderSlotByToken(
                        ident.token
                    );


                if (

                    !owned ||

                    owned.room !==
                        ident.room

                ) {

                    return responderJson(

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

                }


                const agora =
                    Date.now();


                updateOwnedLeaderCombat(

                    ident.token,

                    ident.room,

                    parseBoolean(

                        urlObj.searchParams.get(
                            'alive'
                        )

                    ),

                    normalizarTexto(

                        urlObj.searchParams.get(
                            'target'
                        ) || '',

                        50

                    ),

                    parseTargetId(

                        urlObj.searchParams.get(
                            'targetId'
                        )

                    ),

                    parseCombatMode(

                        urlObj.searchParams.get(
                            'combatMode'
                        )

                    ),

                    agora

                );


                const snapshot =

                    getCombatSnapshot(

                        ident.room,

                        agora

                    );


                return responderJson(

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

            }


            // ==========================================
            // FAST STATE
            // ==========================================

            if (
                urlObj.pathname ===
                '/combat/state'
            ) {

                if (
                    req.method !==
                    'GET'
                ) {

                    return responderJson(

                        res,

                        405,

                        {

                            auth:
                                false,

                            msg:
                                'Metodo nao permitido.'

                        }

                    );

                }


                const ident =
                    validarIdentidade(
                        urlObj
                    );


                if (
                    ident.error
                ) {

                    return responderJson(

                        res,

                        ident.error[0],

                        ident.error[1]

                    );

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
                        ident.room
                    );


                if (
                    since >=
                    snapshot.seq
                ) {

                    return responderJson(

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

                }


                return responderJson(

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

            }


            // ==========================================
            // HEARTBEAT COMPLETO
            // ==========================================

            if (
                urlObj.pathname ===
                '/sync'
            ) {

                if (
                    req.method !==
                    'GET'
                ) {

                    return responderJson(

                        res,

                        405,

                        {

                            auth:
                                false,

                            msg:
                                'Metodo nao permitido.'

                        }

                    );

                }


                const ident =
                    validarIdentidade(
                        urlObj
                    );


                if (
                    ident.error
                ) {

                    return responderJson(

                        res,

                        ident.error[0],

                        ident.error[1]

                    );

                }


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

                        50

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


                // Renova token

                ident.sessao.lastSeen =
                    agora;


                ident.sessao.expiresAt =

                    agora +

                    SESSION_TTL_MS;


                // Player conectado

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


                // Heartbeat separado
                // do estado de combate.

                if (

                    leaderRequested &&

                    myLeader.active ===
                        true

                ) {

                    updateOwnedLeaderHeartbeat(

                        ident.token,

                        ident.room,

                        agora

                    );

                }


                // ==========================================
                // PLAYERS
                // ==========================================

                const playersByName =
                    new Map();


                for (

                    const [
                        outroToken,
                        data
                    ]

                    of conectadosMap

                ) {

                    if (

                        agora -
                            data.timestamp

                        >
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
                        data.room ===
                        ident.room
                    ) {

                        playersByName.set(

                            data.name
                                .toLowerCase(),

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


                const snapshot =

                    getCombatSnapshot(

                        ident.room,

                        agora

                    );


                return responderJson(

                    res,

                    200,

                    {

                        auth:
                            true,

                        room:
                            ident.room,

                        members:

                            players.map(
                                p => p.name
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

            }


            // ==========================================
            // 404
            // ==========================================

            return responderJson(

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

            `[Guild Server V8] Servidor HTTP rodando na porta ${PORT}`

        );

    }

);
