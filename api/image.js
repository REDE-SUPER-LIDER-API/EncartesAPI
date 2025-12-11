const express = require('express');
const { createClient } = require('redis');
const app = express();

// O Vercel gerencia as variáveis de ambiente (process.env)
const UPSTASH_URL = process.env.UPSTASH_REDIS_URL;

let redisClient;

// Função para garantir a conexão com o Redis
async function connectRedis() {
    if (redisClient && redisClient.isReady) {
        return redisClient; // Retorna cliente existente se já estiver conectado
    }

    if (!UPSTASH_URL) {
        console.error('UPSTASH_REDIS_URL não está configurada.');
        return null;
    }

    try {
        redisClient = createClient({ url: UPSTASH_URL });
        redisClient.on('error', (err) => console.error('Upstash Redis Client Error:', err));
        await redisClient.connect();
        console.log('✅ Conexão Upstash (Redis) estabelecida.');
        return redisClient;
    } catch (error) {
        console.error('❌ Falha ao conectar ao Upstash Redis:', error);
        return null;
    }
}

// Função para SIMULAR a recuperação da URL de uma imagem do Cloudinary
function getCloudinaryUrl(imageId) {
    const baseUrl = 'https://res.cloudinary.com/demo/image/upload/';
    // Substitua pela lógica real do Cloudinary
    return `${baseUrl}${imageId}.jpg`;
}


// Rota principal para lidar com as requisições
app.get('/:imageId', async (req, res) => {
    const imageId = req.params.imageId;
    const client = await connectRedis();

    if (!client) {
        // 503 Service Unavailable se o Redis não puder conectar
        return res.status(503).json({ 
            error: 'Serviço de metadados (Upstash) indisponível ou credenciais ausentes.' 
        });
    }

    try {
        // 1. Obter a URL da imagem do Cloudinary
        const imageUrl = getCloudinaryUrl(imageId);

        // 2. Obter Metadados do Upstash (Redis)
        const metadataKey = `metadata:${imageId}`;
        const metadataJson = await client.get(metadataKey);

        let metadata = {};
        if (metadataJson) {
            metadata = JSON.parse(metadataJson);
        } else {
            metadata = { status: 'Metadados não encontrados no Upstash.' };
        }

        // 3. Retornar a Resposta
        res.status(200).json({
            imageId: imageId,
            imageUrl: imageUrl,
            metadata: metadata,
            location: `Vercel Serverless Function: api/image.js`
        });

    } catch (error) {
        console.error(`Erro ao processar a imagem ${imageId}:`, error);
        res.status(500).json({ error: 'Erro interno do servidor ao buscar imagem e metadados.' });
    }
});

// A chave para o Vercel:
// Você deve exportar o app Express para que o Vercel o trate como uma Serverless Function.
module.exports = app;