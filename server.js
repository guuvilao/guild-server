const http = require('http');

const PORT = process.env.PORT || 3000;

// ==========================================
// BANCO DE DADOS DAS SUAS CHAVES VENDIDAS
// É aqui que você vai adicionar as chaves dos seus clientes!
// ==========================================
const chavesValidas = {
    "GUSTAVO-TESTE-123": { ativo: true, dono: "Você" },
    "CLIENTE-001-XYZ": { ativo: true, dono: "João da War" },
    "DREAMNAV-777": { ativo: true, dono: "Membro da Quest" }
};

// Guarda os conectados na memória: { nome: { room: '1031', timestamp: Date.now() } }
let conectadosMap = new Map();

const server = http.createServer((req, res) => {
    const baseUrl = `http://${req.headers.host}`;
    const urlObj = new URL(req.url, baseUrl);
    
    // --- 1. ROTA DE VALIDAÇÃO DE LICENÇA (PRODUCT KEY) ---
    if (urlObj.pathname === '/auth') {
        const key = urlObj.searchParams.get('key');
        
        // Verifica se a chave existe no banco acima e se está ativa
        if (chavesValidas[key] && chavesValidas[key].ativo) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ auth: true, msg: "Licenca Valida! Bem vindo." }));
        } else {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ auth: false, msg: "Key invalida ou expirada." }));
        }
        return;
    }

    // --- 2. ROTA DE SYNC (SISTEMA DE CANAIS/SALAS POR SENHA) ---
    if (urlObj.pathname === '/sync' || urlObj.pathname === '/') {
        // A senha agora define qual "sala" o jogador está vendo (ex: 1031, 1032)
        const pass = urlObj.searchParams.get('pass') || '0'; 
        const name = urlObj.searchParams.get('name');

        // Atualiza a posição do jogador e anota a sala em que ele está
        if (name) { 
            conectadosMap.set(name, { room: pass, timestamp: Date.now() }); 
        }

        const agora = Date.now();
        const membrosDaSala = [];

        // Filtra a lista inteira do servidor
        for (let [jogador, data] of conectadosMap.entries()) {
            if (agora - data.timestamp > 30000) {
                // Remove quem está inativo há mais de 30 segundos (fechou o bot)
                conectadosMap.delete(jogador);
            } else if (data.room === pass) {
                // Só devolve para o cliente quem está com a MESMA senha (mesmo canal)
                membrosDaSala.push(jogador);
            }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ members: membrosDaSala }));
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Rota nao encontrada');
    }
});

server.listen(PORT, () => {
    console.log(`Servidor HTTP rodando na porta ${PORT}`);
});
