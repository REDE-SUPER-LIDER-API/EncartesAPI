const express = require('express');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { Redis } = require('@upstash/redis');

const app = express();

// --- CONFIGURAÇÃO ---
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const ACTIVE_BANNERS_KEY = 'active_banners_ordered'; 
const BANNER_DAYS_KEY = 'banner_day_rules'; 
const DISABLED_BANNERS_KEY = 'disabled_banner_urls'; 
const CLOUDINARY_FOLDER = 'banners_folder'; 

const DAYS_MAP = { 0: 'SUN', 1: 'MON', 2: 'TUE', 3: 'WED', 4: 'THU', 5: 'FRI', 6: 'SAT' };
const VALID_DAYS = [...Object.values(DAYS_MAP), 'ALL'];

// --- MIDDLEWARES ---
app.use(cors());
app.use(express.json()); 
const upload = multer({ storage: multer.memoryStorage() });

// --- UTILITIES ---
const extractPublicIdFromUrl = url => {
    try {
        const folderIndex = url.indexOf(`/${CLOUDINARY_FOLDER}/`);
        if (folderIndex === -1) return null;
        let publicIdPath = url.substring(folderIndex + 1);
        const lastDot = publicIdPath.lastIndexOf('.');
        if (lastDot > 0) publicIdPath = publicIdPath.substring(0, lastDot);
        return publicIdPath;
    } catch (e) {
        console.error('Erro ao extrair public_id:', e);
        return null;
    }
};

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

// --- ROTAS ---

// POST /api/banners: Upload de imagem
app.post('/api/banners', upload.single('bannerImage'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    
    const day = req.body.day ? req.body.day.toUpperCase() : 'ALL';
    if (!VALID_DAYS.includes(day)) return res.status(400).json({ error: `Dia inválido. Use: ${VALID_DAYS.join(', ')}` });

    try {
        const b64 = Buffer.from(req.file.buffer).toString("base64");
        const dataURI = `data:${req.file.mimetype};base64,${b64}`;

        const result = await cloudinary.uploader.upload(dataURI, {
            folder: CLOUDINARY_FOLDER, 
            tags: ['banners_tag']        
        });
        
        const bannerUrl = result.secure_url;
        const newPosition = await redis.zcard(ACTIVE_BANNERS_KEY);

        await Promise.all([
            redis.zadd(ACTIVE_BANNERS_KEY, { score: newPosition, member: bannerUrl }),
            redis.hset(BANNER_DAYS_KEY, { [bannerUrl]: day })
        ]);

        res.status(201).json({ message: 'Upload bem-sucedido e banner ativado!', url: bannerUrl, day, position: newPosition });
    } catch (error) {
        console.error('❌ Erro ao processar upload:', error);
        return res.status(500).json({ error: 'Falha ao fazer upload.', details: error.message });
    }
});

// GET /api/banners: Lista banners ATIVOS para o dia atual
app.get('/api/banners', async (req, res) => {
    try {
        const todayKey = DAYS_MAP[new Date().getDay()];
        const activeBanners = await getActiveBannersOrdered();

        const filteredUrls = activeBanners
            .filter(banner => banner.day === 'ALL' || banner.day === todayKey)
            .map(banner => banner.url);
        
        res.json({ banners: filteredUrls, day: todayKey });
    } catch (error) {
        console.error('❌ Erro ao carregar banners ativos do Redis:', error);
        return res.status(500).json({ error: 'Falha ao carregar banners ativos.' });
    }
});

// GET /api/banners/all: Lista TODOS os banners ATIVOS
app.get('/api/banners/all', async (req, res) => {
    try {
        const activeBanners = await getActiveBannersOrdered(); 
        res.json({ banners: activeBanners });
    } catch (error) {
        console.error('❌ Erro ao carregar todos os banners ativos do Redis:', error);
        return res.status(500).json({ error: 'Falha ao carregar todos os banners ativos.' });
    }
});

// GET /api/banners/disabled: Lista banners DESATIVADOS
app.get('/api/banners/disabled', async (req, res) => {
    try {
        const disabledUrls = await redis.smembers(DISABLED_BANNERS_KEY);
        res.json({ banners: disabledUrls });
    } catch (error) {
        console.error('❌ Erro ao carregar banners desativados do Redis:', error);
        return res.status(500).json({ error: 'Falha ao carregar banners desativados.' });
    }
});

// PUT /api/banners/disable: Desativar banner
app.put('/api/banners/disable', async (req, res) => {
    const { url } = req.body; 
    if (!url) return res.status(400).json({ error: 'A URL do banner é obrigatória.' });

    try {
        const [removedFromActive] = await Promise.all([
            redis.zrem(ACTIVE_BANNERS_KEY, url),
            redis.hdel(BANNER_DAYS_KEY, url)
        ]);

        if (removedFromActive === 0) {
            const wasAlreadyDisabled = await redis.sismember(DISABLED_BANNERS_KEY, url);
            if(wasAlreadyDisabled) return res.status(404).json({ error: 'Banner já está na lista de desativados.' });
            return res.status(404).json({ error: 'Banner não encontrado na lista de ativos.' });
        }

        await redis.sadd(DISABLED_BANNERS_KEY, url);
        return res.json({ message: 'Banner desativado com sucesso.', url });
    } catch (error) {
        console.error('❌ Erro ao desativar banner no Redis:', error);
        return res.status(500).json({ error: 'Falha ao desativar banner.' });
    }
});

// PUT /api/banners/enable: Reativar banner
app.put('/api/banners/enable', async (req, res) => {
    const { url, day } = req.body;
    
    const targetDay = day ? day.toUpperCase() : 'ALL';
    if (!url || !VALID_DAYS.includes(targetDay)) return res.status(400).json({ error: 'A URL do banner é obrigatória e o dia deve ser válido.' });

    try {
        const removedFromDisabled = await redis.srem(DISABLED_BANNERS_KEY, url);

        if (removedFromDisabled === 0) {
            const wasAlreadyActive = await redis.zscore(ACTIVE_BANNERS_KEY, url);
            if (wasAlreadyActive !== null) return res.status(404).json({ error: 'Banner já está ativo.' });
            return res.status(404).json({ error: 'Banner não encontrado na lista de desativados.' });
        }

        const newPosition = await redis.zcard(ACTIVE_BANNERS_KEY);

        await Promise.all([
            redis.zadd(ACTIVE_BANNERS_KEY, { score: newPosition, member: url }),
            redis.hset(BANNER_DAYS_KEY, { [url]: targetDay })
        ]);

        return res.json({ message: 'Banner reativado com sucesso.', url, day: targetDay, position: newPosition });
    } catch (error) {
        console.error('❌ Erro ao reativar banner no Redis:', error);
        return res.status(500).json({ error: 'Falha ao reativar banner.' });
    }
});

// PUT /api/banners/update-day: Atualizar dia
app.put('/api/banners/update-day', async (req, res) => {
    const { url, day } = req.body;
    
    const targetDay = day ? day.toUpperCase() : 'ALL';
    if (!url || !VALID_DAYS.includes(targetDay)) return res.status(400).json({ error: 'A URL do banner é obrigatória e o dia deve ser válido.' });
    
    try {
        const currentPosition = await redis.zscore(ACTIVE_BANNERS_KEY, url);

        if (currentPosition === null) return res.status(404).json({ error: 'Banner não encontrado na lista de ativos.' });

        await redis.hset(BANNER_DAYS_KEY, { [url]: targetDay });

        return res.json({ message: 'Dia de exibição atualizado com sucesso.', url, day: targetDay });
    } catch (error) {
        console.error('❌ Erro ao atualizar o dia do banner no Redis:', error);
        return res.status(500).json({ error: 'Falha ao atualizar o dia do banner.' });
    }
});

// PUT /api/banners/reorder: Reordenar banners
app.put('/api/banners/reorder', async (req, res) => {
    const { orderedUrls } = req.body;

    if (!Array.isArray(orderedUrls)) return res.status(400).json({ error: 'Lista de URLs ordenadas é obrigatória.' });

    try {
        const updates = orderedUrls.map((url, index) => ({ score: index, member: url }));
        if (updates.length === 0) return res.status(200).json({ message: 'Nenhuma URL para reordenar.' });
        
        const updatedCount = await redis.zadd(ACTIVE_BANNERS_KEY, ...updates);

        return res.json({ message: 'Ordem dos banners atualizada com sucesso.', updatedCount });
    } catch (error) {
        console.error('❌ Erro ao reordenar banners no Redis:', error);
        return res.status(500).json({ error: 'Falha ao reordenar banners.' });
    }
});


// DELETE /api/banners: Excluir permanentemente
app.delete('/api/banners', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'A URL do banner é obrigatória para a exclusão.' });

    try {
        const [removedActive, removedDayRule, removedDisabled] = await Promise.all([
            redis.zrem(ACTIVE_BANNERS_KEY, url), 
            redis.hdel(BANNER_DAYS_KEY, url),
            redis.srem(DISABLED_BANNERS_KEY, url) 
        ]);
        
        const redisRemoved = removedActive + removedDisabled; 

        if (redisRemoved === 0 && removedDayRule === 0) return res.status(404).json({ error: 'Banner não encontrado nos registros do Redis.' });

        const publicId = extractPublicIdFromUrl(url);

        if (!publicId) return res.status(200).json({ message: 'Banner removido do Redis, mas falhou ao extrair o ID para exclusão no Cloudinary.', url, redisRemoved });

        const destroyResult = await cloudinary.uploader.destroy(publicId); 
        let cloudinaryStatus = destroyResult.result;
        
        if (cloudinaryStatus === 'not found') cloudinaryStatus = 'removed_from_redis_only (file_not_found_on_cloud)';
        else if (cloudinaryStatus !== 'ok') {
            console.error('❌ Erro ao deletar no Cloudinary:', destroyResult);
            return res.status(200).json({ message: 'Banner removido do Redis, mas houve um erro na exclusão do Cloudinary.', url, cloudinaryStatus });
        }

        return res.json({ message: 'Banner excluído com sucesso.', url, redisRemoved, cloudinaryStatus: 'ok' });
    } catch (error) {
        console.error('❌ Erro ao excluir banner:', error);
        return res.status(500).json({ error: 'Falha ao excluir banner.' });
    }
});


// --- EXPORTAÇÃO VERCEL ---
module.exports = app;