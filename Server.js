// server.js (Versão Limpa e Otimizada com Cloudinary, Upstash Redis e Cron Job)

const express = require('express');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { Redis } = require('@upstash/redis');
const cron = require('node-cron'); // <--- NOVO: Importar node-cron

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

// --- CHAVES DE BANNERS (EXISTENTES) ---
const ACTIVE_BANNERS_KEY = 'active_banners_ordered'; 
const BANNER_DAYS_KEY = 'banner_days_config';
const DISABLED_BANNERS_KEY = 'disabled_banners_set';
const BANNER_FOLDER = 'banners_rotativos'; 

// --- NOVAS CHAVES PARA ENCARTES ---
const ENCARTES_KEY = 'active_encartes_list'; // Lista simples, sem posição ou dia
const ENCARTE_FOLDER = 'encartes_daily'; // Pasta dedicada no Cloudinary

// ------------------------------------------------------------------------
// --- 0. FUNÇÃO DE LIMPEZA PROGRAMADA PARA ENCARTES ---
// ------------------------------------------------------------------------

/**
 * Função para remover todos os encartes ativos do Redis e Cloudinary.
 * Agendado para rodar à 00:00 (Meia-noite) no fuso horário de Brasília (BRT).
 */
async function clearAllEncartes() {
    // Definir o fuso horário para log
    const options = { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit' };
    console.log(`\n🧹 Iniciando limpeza diária de Encartes... (${new Date().toLocaleTimeString('pt-BR', options)})`);
    
    try {
        // 1. Obter URLs de todos os encartes do Redis
        const encarteUrls = await redis.lrange(ENCARTES_KEY, 0, -1);
        
        if (encarteUrls.length === 0) {
            console.log('✅ Nenhum encarte encontrado no Redis para exclusão.');
            return;
        }

        // 2. Extrair Public IDs do Cloudinary
        const publicIds = encarteUrls.map(url => {
            const parts = url.split('/');
            const filenameWithExt = parts[parts.length - 1];
            // Ex: encartes_daily/image_id
            return `${ENCARTE_FOLDER}/${filenameWithExt.split('.')[0]}`;
        });
        
        // 3. Deletar todos os arquivos do Cloudinary
        console.log(`🔥 Deletando ${publicIds.length} arquivos no Cloudinary...`);
        // Usamos api.delete_resources para exclusão em massa, mais eficiente
        const destroyResult = await cloudinary.api.delete_resources(publicIds); 
        
        if (destroyResult.deleted && Object.keys(destroyResult.deleted).length > 0) {
             console.log(`✅ Cloudinary: ${Object.keys(destroyResult.deleted).length} recursos deletados com sucesso.`);
        } else {
             console.log('⚠️ Cloudinary: Nenhum recurso deletado. Resultado:', destroyResult);
        }

        // 4. Remover a chave de lista inteira do Redis.
        await redis.del(ENCARTES_KEY);
        console.log(`✅ Redis: Chave ${ENCARTES_KEY} removida (limpeza total).`);
        
    } catch (error) {
        console.error('❌ Erro durante a limpeza diária de Encartes:', error);
    }
}

// Agendamento do Cron Job para 00:00 (Meia-noite) no fuso horário de Brasília (BRT)
// O agendamento '0 0 * * *' no fuso horário America/Sao_Paulo garante que rode à 00:00 BRT.
cron.schedule('0 0 * * *', clearAllEncartes, {
    scheduled: true,
    timezone: "America/Sao_Paulo" // Força o fuso horário do cron para 00:00 BRT
});

console.log('⏰ Cron job para limpeza diária de encartes agendado para 00:00 BRT.');


// ------------------------------------------------------------------------
// --- 2. MIDDLEWARES E CONFIGURAÇÕES DE UPLOAD ---
// ------------------------------------------------------------------------

app.use(cors());
app.use(express.json()); // Para parsing application/json

// Configuração do Multer (Armazenar na memória para enviar ao Cloudinary)
const upload = multer({ storage: multer.memoryStorage() });


// ------------------------------------------------------------------------
// --- 3. ROTA: GET /api/banners (LISTAR BANNERS ATIVOS) ---
// ------------------------------------------------------------------------

app.get('/api/banners', async (req, res) => {
    // Determinar o dia da semana atual em BRT (GMT-3)
    const now = new Date();
    // Usa toLocaleString para obter o dia da semana em UTC (que é o fuso horário padrão do servidor, mas com o dia correto)
    const dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/Sao_Paulo' }).toUpperCase(); // Ex: MON

    try {
        // 1. Obter URLs dos banners ativos, ordenados pela posição (ZSET)
        // ZRANGE ACTIVE_BANNERS_KEY 0 -1 WITHSCORES
        const activeBanners = await redis.zrange(ACTIVE_BANNERS_KEY, 0, -1, { withScores: true });

        // 2. Obter a configuração de dias de todos os banners (HASH)
        const bannerDaysConfig = await redis.hgetall(BANNER_DAYS_KEY) || {};

        // 3. Obter a lista de banners desativados (SET)
        const disabledBanners = await redis.smembers(DISABLED_BANNERS_KEY) || [];
        const disabledSet = new Set(disabledBanners);

        const bannersForToday = [];
        let position = 0;

        for (let i = 0; i < activeBanners.length; i += 2) {
            const url = activeBanners[i];
            // const score = activeBanners[i + 1]; // Score é a posição

            const dayConfig = bannerDaysConfig[url] || 'ALL'; // Padrão é ALL
            const isActive = !disabledSet.has(url);

            // Filtragem pela lógica: Se o banner está ativo E o dia for ALL ou o dia de hoje
            const isDisplayableToday = isActive && (dayConfig === 'ALL' || dayConfig === dayOfWeek);

            if (isDisplayableToday) {
                // Se o cliente (app) só precisar da URL, podemos simplificar:
                // bannersForToday.push(url);

                // Se precisar de mais detalhes:
                 bannersForToday.push({
                     url: url,
                     day: dayConfig,
                     position: position++, // Posição é dada pela ordem no ZSET
                     status: isActive ? 'active' : 'disabled' // Tecnicamente sempre ativo se passou no filtro 'isActive', mas é bom manter a propriedade
                 });
            }
        }
        
        console.log(`📢 Banners listados para ${dayOfWeek} em BRT: ${bannersForToday.length} ativos.`);
        return res.json(bannersForToday.map(b => ({ url: b.url }))); // Retorna apenas a lista de URLs para o cliente

    } catch (error) {
        console.error('❌ Erro ao listar banners:', error);
        return res.status(500).json({ error: 'Falha ao listar banners.' });
    }
});


// ------------------------------------------------------------------------
// --- 4. ROTAS: UPLOAD/REMOÇÃO/ORDEM de BANNERS (EXISTENTES) ---
// ------------------------------------------------------------------------

// Rota para listar TUDO (incluindo desativados), usado pelo Dashboard
app.get('/api/banners/all', async (req, res) => {
    try {
        // 1. Obter todos os banners ativos, ordenados pela posição (ZSET)
        const activeBanners = await redis.zrange(ACTIVE_BANNERS_KEY, 0, -1, { withScores: true });

        // 2. Obter a configuração de dias (HASH)
        const bannerDaysConfig = await redis.hgetall(BANNER_DAYS_KEY) || {};

        // 3. Obter a lista de banners desativados (SET)
        const disabledBanners = await redis.smembers(DISABLED_BANNERS_KEY) || [];
        const disabledSet = new Set(disabledBanners);

        const allBanners = [];
        const seenUrls = new Set();
        let position = 0;

        // Processa banners ORDENADOS (ACTIVE_BANNERS_KEY)
        for (let i = 0; i < activeBanners.length; i += 2) {
            const url = activeBanners[i];
            const dayConfig = bannerDaysConfig[url] || 'ALL';
            const isActive = !disabledSet.has(url);
            
            allBanners.push({
                url: url,
                day: dayConfig,
                position: position++,
                status: isActive ? 'active' : 'disabled'
            });
            seenUrls.add(url);
        }

        // Processa banners DESATIVADOS (DISABLED_BANNERS_KEY) que não estavam no ZSET por algum motivo (garantindo que todos sejam mostrados)
        for (const url of disabledBanners) {
            if (!seenUrls.has(url)) {
                 allBanners.push({
                    url: url,
                    day: bannerDaysConfig[url] || 'ALL',
                    position: -1, // Indica que não tem posição (está desativado)
                    status: 'disabled'
                });
                seenUrls.add(url);
            }
        }

        // Nota: Banners que estão apenas no HASH (BANNER_DAYS_KEY) mas não no ZSET ou SET são ignorados.
        // O ZSET é a fonte primária de verdade para a lista de banners.

        console.log(`📃 Dashboard: ${allBanners.length} banners carregados (Ativos/Desativados).`);
        return res.json(allBanners);

    } catch (error) {
        console.error('❌ Erro ao listar todos os banners para o dashboard:', error);
        return res.status(500).json({ error: 'Falha ao listar banners.' });
    }
});

// Rota para UPLOAD de Banner
app.post('/api/banners', upload.single('bannerImage'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Nenhuma imagem enviada.' });
        }
        
        const day = req.body.day || 'ALL';

        const base64Image = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;

        // 1. Upload para o Cloudinary
        const uploadResult = await cloudinary.uploader.upload(base64Image, {
            folder: BANNER_FOLDER, 
            resource_type: 'image'
        });

        const bannerUrl = uploadResult.secure_url;

        // 2. Adicionar ao Redis (ZSET para posição e HASH para dia)
        // Adiciona com a pontuação (score) sendo um valor muito alto para ir para o fim da lista
        const maxScore = await redis.zscore(ACTIVE_BANNERS_KEY, 'last_score_tracker');
        const newScore = (maxScore ? parseFloat(maxScore) : 0) + 1;

        await redis.zadd(ACTIVE_BANNERS_KEY, { score: newScore, member: bannerUrl });
        await redis.hset(BANNER_DAYS_KEY, { [bannerUrl]: day });
        // Atualiza o rastreador de score
        await redis.zadd(ACTIVE_BANNERS_KEY, { score: newScore, member: 'last_score_tracker' });

        // Garante que não está na lista de desativados se for recém-adicionado
        await redis.srem(DISABLED_BANNERS_KEY, bannerUrl);

        console.log(`✨ Novo Banner ADICIONADO: ${bannerUrl} com dia ${day} e score ${newScore}`);
        return res.status(201).json({ 
            message: 'Banner enviado e ativado com sucesso!', 
            url: bannerUrl,
            day: day,
            position: newScore 
        });

    } catch (error) {
        console.error('❌ Erro ao enviar banner:', error);
        return res.status(500).json({ error: 'Falha ao enviar banner.' });
    }
});

// Rota para REORDENAR (PUT)
app.put('/api/banners/reorder', async (req, res) => {
    const { urls } = req.body; // URLs na nova ordem [url1, url2, ...]

    if (!Array.isArray(urls) || urls.length === 0) {
        return res.status(400).json({ error: 'Lista de URLs inválida.' });
    }

    try {
        // Remove todos os banners da lista ordenada (ZSET)
        await redis.del(ACTIVE_BANNERS_KEY);

        // Reinsere os banners na nova ordem (index + 1 como score)
        const members = urls.map((url, index) => ({
            score: index + 1,
            member: url
        }));
        
        // Adiciona um rastreador de score
        members.push({ score: urls.length + 1, member: 'last_score_tracker' });

        await redis.zadd(ACTIVE_BANNERS_KEY, ...members);

        console.log(`🔄 Banners REORDENADOS: ${urls.length} itens.`);
        return res.json({ message: 'Ordem dos banners atualizada com sucesso.' });

    } catch (error) {
        console.error('❌ Erro ao reordenar banners:', error);
        return res.status(500).json({ error: 'Falha ao reordenar banners.' });
    }
});

// Rota para ATIVAR/DESATIVAR (PUT)
app.put('/api/banners/toggle', async (req, res) => {
    const { url, status } = req.body; // status: 'active' ou 'disabled'

    if (!url || !['active', 'disabled'].includes(status)) {
        return res.status(400).json({ error: 'URL ou status inválido.' });
    }

    try {
        if (status === 'disabled') {
            // Adiciona à lista de desativados
            await redis.sadd(DISABLED_BANNERS_KEY, url);
            
            console.log(`🚫 Banner DESATIVADO: ${url}`);
            return res.json({ message: 'Banner desativado com sucesso.', status: 'disabled' });
            
        } else if (status === 'active') {
            // Remove da lista de desativados
            await redis.srem(DISABLED_BANNERS_KEY, url);
            
            // Reativação também pode redefinir o dia para o padrão (ALL)
            const dayToReactivate = req.body.day || 'ALL';
            await redis.hset(BANNER_DAYS_KEY, { [url]: dayToReactivate });
            
            // Garante que o banner esteja na lista ordenada (caso tenha sido removido/esquecido)
            const scoreExists = await redis.zscore(ACTIVE_BANNERS_KEY, url);
            if (scoreExists === null) {
                // Adiciona ao final da lista ordenada
                const maxScore = await redis.zscore(ACTIVE_BANNERS_KEY, 'last_score_tracker');
                const newScore = (maxScore ? parseFloat(maxScore) : 0) + 1;
                await redis.zadd(ACTIVE_BANNERS_KEY, { score: newScore, member: url });
                await redis.zadd(ACTIVE_BANNERS_KEY, { score: newScore, member: 'last_score_tracker' });
            }

            console.log(`✅ Banner ATIVADO: ${url}`);
            return res.json({ message: 'Banner ativado com sucesso.', status: 'active' });
        }

    } catch (error) {
        console.error('❌ Erro ao ativar/desativar banner:', error);
        return res.status(500).json({ error: 'Falha ao ativar/desativar banner.' });
    }
});

// Rota para ATUALIZAR DIA (PUT)
app.put('/api/banners/day', async (req, res) => {
    const { url, day } = req.body; 

    if (!url || !day) {
        return res.status(400).json({ error: 'URL ou dia inválido.' });
    }

    try {
        // Atualiza a configuração de dia no HASH
        await redis.hset(BANNER_DAYS_KEY, { [url]: day });
        
        console.log(`📅 Banner ${url} atualizado para o dia ${day}`);
        return res.json({ message: 'Dia de exibição atualizado com sucesso.', day });

    } catch (error) {
        console.error('❌ Erro ao atualizar dia do banner:', error);
        return res.status(500).json({ error: 'Falha ao atualizar dia do banner.' });
    }
});

// Rota para DELETAR Banner
app.delete('/api/banners/:url', async (req, res) => {
    const url = decodeURIComponent(req.params.url);

    try {
        // 1. Remove de todas as chaves do Redis
        const redisRemovedFromZSet = await redis.zrem(ACTIVE_BANNERS_KEY, url);
        const redisRemovedFromDayHash = await redis.hdel(BANNER_DAYS_KEY, url);
        const redisRemovedFromDisabledSet = await redis.srem(DISABLED_BANNERS_KEY, url);

        const redisRemoved = redisRemovedFromZSet + redisRemovedFromDayHash + redisRemovedFromDisabledSet;

        if (redisRemoved === 0) {
            console.warn(`⚠️ Redis: Banner ${url} não encontrado no Redis para exclusão.`);
        }
        
        let publicId;
        
        try {
            // Extrai o public ID do Cloudinary
            // Ex: .../banners_rotativos/image_id.jpg -> banners_rotativos/image_id
            const parts = url.split('/');
            const filenameWithExt = parts[parts.length - 1];
            publicId = `${BANNER_FOLDER}/${filenameWithExt.split('.')[0]}`;
        } catch (e) {
             console.warn(`⚠️ Cloudinary: Falha ao extrair ID para exclusão. URL: ${url}`);
             return res.status(200).json({ message: 'Banner removido do Redis, mas falhou ao extrair o ID para exclusão no Cloudinary.', url, redisRemoved });
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
            return res.status(200).json({ message: 'Banner removido do Redis, mas houve um erro na exclusão do Cloudinary.', url, cloudinaryStatus });
        }


        console.log(`🔥 Banner EXCLUÍDO permanentemente: ${url}`);
        return res.json({ message: 'Banner excluído com sucesso.', url, redisRemoved, cloudinaryStatus: 'ok' });

    } catch (error) {
        console.error('❌ Erro ao excluir banner:', error);
        return res.status(500).json({ error: 'Falha ao excluir banner.' });
    }
});


// ========================================================================
// --- 5. NOVAS ROTAS: /api/encartes ---
// ========================================================================

// Rota para LISTAR ENCARTES ATIVOS
app.get('/api/encartes', async (req, res) => {
    try {
        // Retorna todos os encartes na ordem de upload (ou seja, a ordem da lista)
        // LRANGE ENCARTES_KEY 0 -1
        const activeEncartesUrls = await redis.lrange(ENCARTES_KEY, 0, -1);
        
        // Retorna a lista no formato que o cliente espera
        const encartes = activeEncartesUrls.map(url => ({ url }));

        console.log(`🖼️ Listagem de Encartes: ${encartes.length} encontrados.`);
        return res.json(encartes);

    } catch (error) {
        console.error('❌ Erro ao listar encartes:', error);
        return res.status(500).json({ error: 'Falha ao listar encartes.' });
    }
});


// Rota para UPLOAD DE NOVO ENCARTE
app.post('/api/encartes', upload.single('encarteImage'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Nenhuma imagem enviada.' });
        }

        const base64Image = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;

        // 1. Upload para o Cloudinary na pasta dedicada
        const uploadResult = await cloudinary.uploader.upload(base64Image, {
            folder: ENCARTE_FOLDER, // Usa a nova pasta
            resource_type: 'image'
        });

        const encarteUrl = uploadResult.secure_url;

        // 2. Adiciona ao Redis na chave de encartes (Lista)
        // LPUSH adiciona no início da lista (mais recente primeiro)
        await redis.lpush(ENCARTES_KEY, encarteUrl);

        console.log(`✨ Novo Encarte ADICIONADO: ${encarteUrl}`);
        return res.status(201).json({ 
            message: 'Encarte enviado e ativado com sucesso!', 
            url: encarteUrl,
            public_id: uploadResult.public_id
        });

    } catch (error) {
        console.error('❌ Erro ao enviar encarte:', error);
        return res.status(500).json({ error: 'Falha ao enviar encarte.' });
    }
});


// Rota para EXCLUIR ENCARTE
app.delete('/api/encartes/:url', async (req, res) => {
    const url = decodeURIComponent(req.params.url);

    try {
        // 1. Tenta remover do Redis (Lista). LREM remove a primeira ocorrência do valor.
        const redisRemovedCount = await redis.lrem(ENCARTES_KEY, 1, url);
        
        if (redisRemovedCount === 0) {
            console.warn(`⚠️ Redis: Encarte ${url} não encontrado na lista para exclusão.`);
        }
        
        let publicId;
        
        try {
            // Extrai o public ID do Cloudinary
            const parts = url.split('/');
            const filenameWithExt = parts[parts.length - 1];
            publicId = `${ENCARTE_FOLDER}/${filenameWithExt.split('.')[0]}`;
        } catch (e) {
             console.warn(`⚠️ Cloudinary: Falha ao extrair ID para exclusão. URL: ${url}`);
             return res.status(200).json({ message: 'Encarte removido do Redis, mas falhou ao extrair o ID para exclusão no Cloudinary.', url, redisRemovedCount });
        }

        // 2. Deleta do Cloudinary
        const destroyResult = await cloudinary.uploader.destroy(publicId); 
        
        let cloudinaryStatus = destroyResult.result;
        
        if (cloudinaryStatus === 'not found') {
             console.warn(`⚠️ Cloudinary: Arquivo ${publicId} não encontrado na nuvem, mas removido do Redis.`);
             cloudinaryStatus = 'removed_from_redis_only (file_not_found_on_cloud)';
        } else if (cloudinaryStatus !== 'ok') {
            console.error('❌ Erro ao deletar no Cloudinary:', destroyResult);
            return res.status(200).json({ message: 'Encarte removido do Redis, mas houve um erro na exclusão do Cloudinary.', url, cloudinaryStatus });
        }


        console.log(`🔥 Encarte EXCLUÍDO permanentemente: ${url}`);
        return res.json({ message: 'Encarte excluído com sucesso.', url, redisRemovedCount, cloudinaryStatus: 'ok' });

    } catch (error) {
        console.error('❌ Erro ao excluir encarte:', error);
        return res.status(500).json({ error: 'Falha ao excluir encarte.' });
    }
});


// ------------------------------------------------------------------------
// --- 6. EXPORTAÇÃO VERCEL ---
// ------------------------------------------------------------------------

// Listen para ambiente de desenvolvimento
const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
    });
}

// Exportação Vercel (mantenha inalterado)
module.exports = app;