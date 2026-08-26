const http = require('http');

const PORT = process.env.PORT || 3000;
const SENHA_MESTRE = "1031"; 

let conectadosMap = new Map();

const server = http.createServer((req, res) => {
    // Trata URLs com parâmetros de forma flexível
    const baseUrl = `http://${req.headers.host}`;
    const urlObj = new URL(req.url, baseUrl);
    
    if (urlObj.pathname === '/sync' || urlObj.pathname === '/') {
        const pass = urlObj.searchParams.get('pass');
        const name = urlObj.searchParams.get('name');

        // Valida a senha (se vier vazia ou errada)
        if (pass !== SENHA_MESTRE) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Senha incorreta' }));
            return;
        }

        // Se enviou o nome do personagem, registra na lista
        if (name) {
            conectadosMap.set(name, Date.now());
        }

        // Remove inativos há mais de 30 segundos
        const agora = Date.now();
        for (let [jogador, timestamp] of conectadosMap.entries()) {
            if (agora - timestamp > 30000) {
                conectadosMap.delete(jogador);
            }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ members: Array.from(conectadosMap.keys()) }));
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Rota nao encontrada');
    }
});

server.listen(PORT, () => {
    console.log(`Servidor HTTP rodando na porta ${PORT}`);
});
