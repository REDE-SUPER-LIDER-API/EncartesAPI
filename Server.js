// server.js (Versão com Suporte a Banners e Encartes)

const express = require('express');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { Redis } = require('@upstash/redis');
const { extractPublicIdFromUrl } = require('./utils'); // Presumindo que você tem essa função auxiliar

const app = express();

// ------------------------------------------------------------------------
// --- 1. CONFIGURAÇÃO DE SERVIÇOS E VARIÁVEIS GLOBAIS ---
// ------------------------------------------------------------------------

// Configuração Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Configuração Upstash (Redis)
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// --- CHAVES ATUALIZADAS PARA BANNERS (ZSET/HASH) ---
const ACTIVE_BANNERS_KEY = 'active_banners_ordered'; 
const BANNER_DAYS_KEY = 'banner_day_rules'; 
const DISABLED_BANNERS_KEY = 'disabled_banner_urls'; 
const CLOUDINARY_FOLDER = 'banners_folder'; 
const FOLDER_TAG = 'banners_tag'; 

// --- NOVAS CHAVES PARA ENCARTES (SET) ---
const ENCARTES_KEY = 'encartes_urls'; // SET simples de URLs
const ENCARTES_CLOUDINARY_FOLDER = 'encartes_folder'; // Nova pasta Cloudinary
const ENCARTES_FOLDER_TAG = 'encartes_tag'; // Novo tag

const DAYS_MAP = {
    'MON': 'MON', 'TUE': 'TUE', 'WED': 'WED', 'THU': 'THU', 
    'FRI': 'FRI', 'SAT': 'SAT', 'SUN': 'SUN'
};

// ------------------------------------------------------------------------
// --- 2. MIDDLEWARES E CONFIGURAÇÃO ---
// ------------------------------------------------------------------------

// Configuração CORS (Permitindo todos para desenvolvimento, ajuste para produção)
app.use(cors()); 

// Middleware para processar upload de arquivos (Buffer)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Extrai o ID público do Cloudinary (Essa função deve estar em 'utils.js' ou definida aqui)
function extractPublicIdFromUrl(url) {
    if (!url) return null;
    try {
        const parts = url.split('/');
        // O public_id está sempre na penúltima parte antes da extensão,
        // mas pode incluir a pasta se o URL não tiver a versão (vXX)
        const filenameWithExtension = parts.pop(); 
        const folderAndFilename = parts.slice(parts.indexOf('upload') + 1).join('/');

        // Remove a versão (vXXX/) se existir
        const publicIdMatch = folderAndFilename.match(/(?:v\d+\/)?(.*)\.\w{3,4}$/);
        if (publicIdMatch && publicIdMatch[1]) {
            return publicIdMatch[1];
        }

        // Tenta um fallback mais simples se a regex falhar
        const publicIdClean = filenameWithExtension.split('.')[0];
        if (parts.length > 0) {
            return parts.slice(-1) + '/' + publicIdClean;
        }

        return null;

    } catch (e) {
        console.error('Falha ao extrair Public ID:', e);
        return null;
    }
}


// ------------------------------------------------------------------------
// --- 3. ROTAS DE CLIENTE (VISUALIZAÇÃO DE BANNERS) ---
// ------------------------------------------------------------------------

// ... (Mantenha as rotas GET /api/banners e GET /api/disabled-banners inalteradas, se existirem) ...


/**
 * GET /api/encartes/client: Lista todos os Encartes ATIVOS (Para o Cliente).
 */
app.get('/api/encartes/client', async (req, res) => {
    try {
        // Encartes são apenas uma lista simples de URLs
        const encarteUrls = await redis.smembers(ENCARTES_KEY); 
        
        res.json({ 
            count: encarteUrls.length, 
            encartes: encarteUrls 
        });
        
    } catch (error) {
        console.error('❌ Erro ao carregar encartes para o cliente:', error);
        return res.status(500).json({ error: 'Falha ao carregar encartes.' });
    }
});


// ------------------------------------------------------------------------
// --- 4. ROTAS DE ADMIN (DASHBOARD) ---
// ------------------------------------------------------------------------


/**
 * POST /api/banners: Upload de imagem para o Cloudinary e ativação no Redis.
 * SUPORTA AGORA 'type' para Banners ou Encartes.
 */
app.post('/api/banners', upload.single('bannerImage'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }
    
    // NOVO: Verifica o tipo
    const type = req.body.type ? req.body.type.toLowerCase() : 'banner'; 
    
    // Configurações baseadas no tipo
    let targetFolder, targetTag, targetRedisKey;
    
    if (type === 'encarte') {
        targetFolder = ENCARTES_CLOUDINARY_FOLDER;
        targetTag = ENCARTES_FOLDER_TAG;
        targetRedisKey = ENCARTES_KEY;
    } else if (type === 'banner') {
        targetFolder = CLOUDINARY_FOLDER;
        targetTag = FOLDER_TAG;
        targetRedisKey = ACTIVE_BANNERS_KEY;
    } else {
        return res.status(400).json({ error: 'Tipo de upload inválido. Use "banner" ou "encarte".' });
    }

    // Lógica de Dia (Apenas para Banners)
    const day = req.body.day ? req.body.day.toUpperCase() : 'ALL';
    const validDays = [...Object.values(DAYS_MAP), 'ALL'];

    if (type === 'banner' && !validDays.includes(day)) {
        return res.status(400).json({ error: `Dia inválido. Use: ${validDays.join(', ')}` });
    }

    try {
        const b64 = Buffer.from(req.file.buffer).toString("base64");
        const dataURI = `data:${req.file.mimetype};base64,${b64}`;

        // 1. Upload para o Cloudinary (usa a pasta correta)
        const result = await cloudinary.uploader.upload(dataURI, {
            folder: targetFolder, 
            tags: [targetTag, type] // Adiciona o tipo como tag
        });
        
        const bannerUrl = result.secure_url;

        // 2. Adicionar ao Redis
        if (type === 'banner') {
            const currentSize = await redis.zcard(ACTIVE_BANNERS_KEY);
            const newPosition = currentSize;
            await redis.zadd(ACTIVE_BANNERS_KEY, { score: newPosition, member: bannerUrl });
            await redis.hset(BANNER_DAYS_KEY, { [bannerUrl]: day });
            
            console.log(`✅ Banner ${result.public_id} enviado e URL adicionada ao Redis com dia: ${day} e posição: ${newPosition}.`);
        } else if (type === 'encarte') {
            await redis.sadd(targetRedisKey, bannerUrl); // Adiciona ao SET de encartes
            
            console.log(`✅ Encarte ${result.public_id} enviado e URL adicionada ao Redis.`);
        }


        res.status(201).json({ 
            message: 'Upload bem-sucedido e item ativado!', 
            url: bannerUrl,
            type: type,
            ...(type === 'banner' ? { day: day, position: (await redis.zscore(ACTIVE_BANNERS_KEY, bannerUrl)) } : {})
        });

    } catch (error) {
        console.error('❌ Erro ao processar upload:', error);
        return res.status(500).json({ error: 'Falha ao fazer upload.', details: error.message });
    }
});


/**
 * GET /api/encartes: Lista todos os Encartes (Para o Dashboard).
 */
app.get('/api/encartes', async (req, res) => {
    try {
        const encarteUrls = await redis.smembers(ENCARTES_KEY);
        if (encarteUrls.length === 0) {
            console.log("ℹ️ Nenhum encarte encontrado.");
        }
        res.json({ encartes: encarteUrls });
        
    } catch (error) {
        console.error('❌ Erro ao carregar encartes do Redis:', error);
        return res.status(500).json({ error: 'Falha ao carregar encartes.' });
    }
});


/**
 * DELETE /api/banners: Exclui um banner OU um encarte permanentemente.
 * Rota unificada para excluir.
 */
app.delete('/api/banners', async (req, res) => {
    const { url, type } = req.query; // Recebe o tipo para saber onde procurar no Redis

    if (!url) {
        return res.status(400).json({ error: 'URL do item a ser excluído é obrigatória.' });
    }
    
    // 1. Remove do Redis
    let redisRemoved = 0;
    
    if (type === 'encarte') {
        redisRemoved = await redis.srem(ENCARTES_KEY, url);
    } else {
        // Assume que é banner, remove de todos os possíveis locais
        redisRemoved += await redis.zrem(ACTIVE_BANNERS_KEY, url); // Tenta remover dos ativos
        redisRemoved += await redis.srem(DISABLED_BANNERS_KEY, url); // Tenta remover dos desativados
        await redis.hdel(BANNER_DAYS_KEY, url); // Remove a regra de dia
    }
    
    if (redisRemoved === 0 && type !== 'encarte') {
        console.warn(`⚠️ O item ${url} não foi encontrado em nenhuma lista ativa/desativada do Redis.`);
        // Prossegue para exclusão no Cloudinary mesmo que não esteja no Redis.
    } else if (redisRemoved === 0 && type === 'encarte') {
        console.warn(`⚠️ O encarte ${url} não foi encontrado na lista de encartes do Redis.`);
        // Prossegue para exclusão no Cloudinary.
    }

    // 2. Extrai publicId
    const publicId = extractPublicIdFromUrl(url);

    if (!publicId) {
         return res.status(200).json({ message: 'Item removido do Redis, mas falhou ao extrair o ID para exclusão no Cloudinary.', url, redisRemoved });
    }

    // 3. Deleta do Cloudinary
    const destroyResult = await cloudinary.uploader.destroy(publicId); 
    
    let cloudinaryStatus = destroyResult.result;
    
    if (cloudinaryStatus === 'not found') {
         console.warn(`⚠️ Cloudinary: Arquivo ${publicId} não encontrado na nuvem, mas removido do Redis.`);
         cloudinaryStatus = 'removed_from_redis_only (file_not_found_on_cloud)';
    } else if (cloudinaryStatus !== 'ok') {
        console.error('❌ Erro ao deletar no Cloudinary:', destroyResult);
        // Retorna sucesso para o Redis mas notifica o problema no Cloudinary
        return res.status(200).json({ message: 'Item removido do Redis, mas houve um erro na exclusão do Cloudinary.', url, cloudinaryStatus });
    }


    console.log(`🔥 Item EXCLUÍDO permanentemente: ${url}`);
    return res.json({ message: 'Item excluído com sucesso.', url, redisRemoved, cloudinaryStatus: 'ok', type: type });

} catch (error) {
    console.error('❌ Erro ao excluir item:', error);
    return res.status(500).json({ error: 'Falha ao excluir item.' });
}
});


/**
 * DELETE /api/encartes/cleanup: Rota chamada por CRON JOB para excluir TODOS os Encartes.
 */
app.delete('/api/encartes/cleanup', async (req, res) => {
    try {
        // 1. Obtém todas as URLs dos encartes
        const encarteUrls = await redis.smembers(ENCARTES_KEY);

        if (encarteUrls.length === 0) {
            console.log("ℹ️ CRON: Nenhum encarte para excluir.");
            return res.json({ message: 'Nenhum encarte para excluir.', totalDeleted: 0, redisStatus: 'skip' });
        }
        
        const publicIds = [];
        const validUrls = [];

        // 2. Extrai public_ids
        encarteUrls.forEach(url => {
            const publicId = extractPublicIdFromUrl(url);
            if (publicId && publicId.startsWith(ENCARTES_CLOUDINARY_FOLDER)) {
                 publicIds.push(publicId);
                 validUrls.push(url);
            } else {
                 console.warn(`⚠️ CRON: Falha ao extrair public_id do encarte: ${url}.`);
            }
        });

        // 3. Deleta do Cloudinary
        let cloudinaryResult = { deleted: [] };
        if (publicIds.length > 0) {
            cloudinaryResult = await cloudinary.api.delete_resources(publicIds);
        }
        
        // 4. Deleta do Redis (Remove o SET completo, mais eficiente)
        const redisRemoved = await redis.del(ENCARTES_KEY); 
        
        
        console.log(`🔥 CRON: Encartes EXCLUÍDOS. Redis keys removidas: ${redisRemoved}. Cloudinary: ${cloudinaryResult.deleted.length} arquivos.`);
        
        return res.json({ 
            message: 'Limpeza de encartes concluída.', 
            totalDeleted: validUrls.length, 
            redisStatus: redisRemoved > 0 ? 'deleted' : 'not_found',
            cloudinaryDeleted: cloudinaryResult.deleted.length
        });

    } catch (error) {
        console.error('❌ CRON: Erro ao excluir encartes:', error);
        return res.status(500).json({ error: 'Falha na exclusão diária de encartes.', details: error.message });
    }
});


// ------------------------------------------------------------------------
// --- 5. EXPORTAÇÃO VERCEL ---
// ------------------------------------------------------------------------

if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
    });
}

// Exporta o app para o Vercel Serverless Function
module.exports = app;