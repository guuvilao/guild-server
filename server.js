const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

// Defina a senha oficial da guilda aqui no servidor
const SENHA_MESTRE = "1031"; 

let conectados = [];

wss.on('connection', (ws) => {
    console.log('Novo membro conectado!');

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            // Valida se a senha enviada pelo bot confere com a senha do servidor
            if (data.pass !== SENHA_MESTRE) {
                console.log('Tentativa de conexão negada: Senha incorreta.');
                return; // Ignora o pacote se a senha estiver errada
            }

            // Se a senha estiver certa, processa a sincronização
            if (data.type === 'SYNC_MEMBERS') {
                conectados = data.members || [];
                
                wss.clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'UPDATE_MEMBERS', members: conectados }));
                    }
                });
            }
        } catch (e) {
            console.log('Erro ao processar mensagem:', e);
        }
    });

    ws.on('close', () => {
        console.log('Membro desconectado.');
    });
});

console.log(`Servidor rodando na porta ${PORT}`);
