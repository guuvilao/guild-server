const WebSocket = require('ws');

// Usa a porta que o provedor gratuito fornecer, ou a porta 3000 localmente
const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

let conectados = [];

wss.on('connection', (ws) => {
    console.log('Novo membro conectado!');

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            // Se um líder enviar a lista ou o alvo, retransmite para todos
            if (data.type === 'SYNC_MEMBERS') {
                conectados = data.members || [];
                
                // Espalha a atualização para todos os clientes conectados
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