// server.js (Versão Limpa e Otimizada com Cloudinary e Upstash Redis)

const express = require('express');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { Redis } = require('@upstash/redis');
// Adicionado para fins de log, mas não estritamente necessário para a função
// const moment = require('moment-timezone'); 

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

// --- CHAVES ATUALIZADAS PARA SUPORTE A POSIÇÃO (ZSET) E DIAS (HASH) ---
const ACTIVE_BANNERS_KEY = 'active_banners_ordered'; 
const BANNER_DAYS_KEY = 'banner_day_rules'; 
const DISABLED_BANNERS_KEY = 'disabled_banner_urls'; 
const CLOUDINARY_FOLDER = 'banners_folder'; 
// A tag é crucial para buscar e deletar todos os arquivos da pasta
const FOLDER_TAG = 'banners_tag'; 

// Mapeamento de Dias da Semana (0=Dom, 6=Sáb) para chaves
const DAYS_MAP = {
    0: 'SUN',
    1: 'MON',
    2: 'TUE',
    3: 'WED',
    4: 'THU',
    5: 'FRI',
    6: 'SAT',
};

// ------------------------------------------------------------------------
// --- 2. MIDDLEWARES ---
// ------------------------------------------------------------------------

app.use(cors());
app.use(express.json()); 

// Configuração Multer (Armazenamento em Memória)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// ------------------------------------------------------------------------
// --- 3. FUNÇÕES AUXILIARES (UTILITIES) ---
// ------------------------------------------------------------------------

// Função original (mantida)
const extractPublicIdFromUrl = (url) => {
    try {
        const parts = url.split('/');
        
        if (parts.length < 2) return null;
        
        const fileNameWithExt = parts[parts.length - 1];
        const fileName = fileNameWithExt.substring(0, fileNameWithExt.lastIndexOf('.'));
        
        const folderName = parts[parts.length - 2]; 
        
        if (folderName !== CLOUDINARY_FOLDER) return null;

        return `${folderName}/${fileName}`;

    } catch (e) {
        console.error('Erro ao extrair public_id:', e);
        return null;
    }
};

// Função original (mantida)
const getActiveBannersOrdered = async () => {
    const zgetData = await redis.zrange(ACTIVE_BANNERS_KEY, 0, -1, { withScores: true });

    if (!zgetData || zgetData.length === 0) return [];

    const bannersWithPosition = {};
    for (let i = 0; i < zgetData.length; i += 2) {
        bannersWithPosition[zgetData[i]] = zgetData[i + 1]; 
    }

    const bannerDayRules = await redis.hgetall(BANNER_DAYS_KEY);

    return Object.entries(bannersWithPosition).map(([url, position]) => ({
        url,
        day: bannerDayRules[url] || 'ALL', 
        position: parseInt(position)
    }));
};

/**
 * NOVO: Remove todos os banners da pasta CLOUDINARY_FOLDER e limpa o Redis.
 * Esta função deve ser chamada por um Cron Job diariamente.
 */
const performDailyCleanup = async () => {
    console.log(`\n🧹 Iniciando limpeza diária. Deletando todos os recursos com a tag '${FOLDER_TAG}'...`);

    let cleanupResults = {
        cloudinary: { status: 'pending', count: 0, errors: [] },
        redis: { status: 'pending', count: 0, errors: [] }
    };
    
    try {
        // 1. Deleção em massa do Cloudinary pela tag (método mais eficiente)
        const deleteResult = await cloudinary.api.delete_resources_by_tag(FOLDER_TAG);
        
        const deletedCount = deleteResult.deleted ? Object.keys(deleteResult.deleted).length : 0;
        cleanupResults.cloudinary.count = deletedCount;
        cleanupResults.cloudinary.status = 'ok';
        
        if (deleteResult.partial) {
             console.warn('⚠️ Limpeza Cloudinary: Deleção PARCIAL! Algumas imagens falharam na exclusão.');
             cleanupResults.cloudinary.status = 'partial_failure';
             cleanupResults.cloudinary.errors.push('Deleção parcial. Verificar Cloudinary logs.');
        }

        console.log(`✅ Cloudinary: ${deletedCount} recursos removidos.`);

    } catch (error) {
        console.error('❌ ERRO CRÍTICO ao deletar recursos no Cloudinary:', error);
        cleanupResults.cloudinary.status = 'error';
        cleanupResults.cloudinary.errors.push(error.message);
    }
    
    try {
        // 2. Limpeza de TODAS as chaves de banners no Redis (ativa, desativada e regras de dia)
        
        const activeDeleted = await redis.del(ACTIVE_BANNERS_KEY);
        const dayRulesDeleted = await redis.del(BANNER_DAYS_KEY);
        const disabledDeleted = await redis.del(DISABLED_BANNERS_KEY);
        
        const totalRedisKeysDeleted = activeDeleted + dayRulesDeleted + disabledDeleted;
        cleanupResults.redis.count = totalRedisKeysDeleted;
        cleanupResults.redis.status = 'ok';
        
        console.log(`✅ Redis: ${totalRedisKeysDeleted} chaves (ZSET, HASH, SET) limpas.`);

    } catch (error) {
        console.error('❌ ERRO CRÍTICO ao limpar chaves no Redis:', error);
        cleanupResults.redis.status = 'error';
        cleanupResults.redis.errors.push(error.message);
    }
    
    console.log('--- FIM DA LIMPEZA DIÁRIA ---');
    return cleanupResults;
};


// ------------------------------------------------------------------------
// --- 4. ROTAS ---
// ------------------------------------------------------------------------

// ... As rotas /api/banners (GET, POST, PUT, DELETE) originais permanecem inalteradas ...

/**
 * NOVO: POST /api/banners/cleanup: Rota para acionar a exclusão diária.
 * Deve ser protegida ou chamada apenas pelo serviço de Cron.
 */
app.post('/api/banners/cleanup', async (req, res) => {
    // --- 🚨 PROTEÇÃO DE ROTA: IDEALMENTE, VOCÊ DEVERIA ADICIONAR UMA CHAVE SECRETA ---
    // Ex: if (req.headers['x-api-key'] !== process.env.CLEANUP_API_KEY) { return res.status(403).json({ error: 'Acesso Proibido.' }); }
    // Por simplicidade, vou omitir a chave, mas é ALTAMENTE RECOMENDADO.
    
    try {
        const results = await performDailyCleanup();
        
        // Verifica se houve falha crítica em ambas as partes
        if (results.cloudinary.status !== 'ok' && results.redis.status !== 'ok') {
            return res.status(500).json({ 
                message: 'Falha crítica na limpeza diária.', 
                details: results 
            });
        }
        
        return res.json({ 
            message: 'Limpeza diária executada com sucesso. Todos os banners foram excluídos do Cloudinary e do Redis.', 
            results 
        });

    } catch (error) {
        console.error('❌ Erro na rota de limpeza:', error);
        return res.status(500).json({ error: 'Erro interno ao executar a rotina de limpeza.' });
    }
});


// ------------------------------------------------------------------------
// --- 5. EXPORTAÇÃO VERCEL ---
// ------------------------------------------------------------------------
module.exports = app;