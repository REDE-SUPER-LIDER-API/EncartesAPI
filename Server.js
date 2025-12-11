const express = require('express');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { Redis } = require('@upstash/redis');

const app = express();

// ------------------------------------------------------------------------
// --- 1. CONFIGURAÇÃO E VARIÁVEIS GLOBAIS ---
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

// Chaves Redis
const ACTIVE_BANNERS_KEY = 'active_banners_ordered'; 
const BANNER_DAYS_KEY = 'banner_day_rules'; 
const DISABLED_BANNERS_KEY = 'disabled_banner_urls'; 
const CLOUDINARY_FOLDER = 'banners_folder'; 
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

// Validação Centralizada
const VALID_DAYS = [...Object.values(DAYS_MAP), 'ALL'];

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

/**
 * Extrai o 'public_id' completo (com a pasta) da URL do Cloudinary.
 * Ex: 'banners_folder/public_id_aqui'
 * @param {string} url - A URL completa do banner.
 * @returns {string | null} O public_id ou null em caso de falha.
 */
const extractPublicIdFromUrl = (url) => {
    try {
        // Encontra o index da pasta no caminho
        const folderIndex = url.indexOf(`/${CLOUDINARY_FOLDER}/`);
        if (folderIndex === -1) return null;
        
        // Extrai a parte do caminho após a pasta (incluindo o CLOUDINARY_FOLDER)
        let publicIdPath = url.substring(folderIndex + 1);
        
        // Remove a extensão do arquivo (ex: .png)
        const lastDot = publicIdPath.lastIndexOf('.');
        if (lastDot > 0) {
            publicIdPath = publicIdPath.substring(0, lastDot);
        }
        
        return publicIdPath;

    } catch (e) {
        console.error('Erro ao extrair public_id:', e);
        return null;
    }
};

/**
 * Retorna os banners ativos com a respectiva posição e dia.
 * @returns {Array<{url: string, day: string, position: number}>} Lista de banners ativos e ordenados.
 */
const getActiveBannersOrdered = async () => {
    // 1. Obtém todos os membros (URLs) e scores (posições) do ZSET, ordenados por score.
    const zgetData = await redis.zrange(ACTIVE_BANNERS_KEY, 0, -1, { withScores: true });

    if (!zgetData || zgetData.length === 0) return [];

    // 2. Transforma o array em um mapa de {url: position}
    const bannersWithPosition = {};
    for (let i = 0; i < zgetData.length; i += 2) {
        // zgetData é [url, score, url, score, ...]
        bannersWithPosition[zgetData[i]] = zgetData[i + 1]; 
    }

    // 3. Obtém todas as regras de dia do Hash
    const bannerDayRules = await redis.hgetall(BANNER_DAYS_KEY);

    // 4. Combina as informações
    return Object.entries(bannersWithPosition).map(([url, position]) => ({
        url,
        day: bannerDayRules[url] || 'ALL', 
        position: parseInt(position)
    }));
};


// ------------------------------------------------------------------------
// --- 4. ROTAS ---
// ------------------------------------------------------------------------

/**
 * POST /api/banners: Upload de imagem para o Cloudinary e ativação no Redis.
 */
app.post('/api/banners', upload.single('bannerImage'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }
    
    // Day Validation
    const day = req.body.day ? req.body.day.toUpperCase() : 'ALL';
    if (!VALID_DAYS.includes(day)) {
        return res.status(400).json({ error: `Dia inválido. Use: ${VALID_DAYS.join(', ')}` });
    }

    try {
        const b64 = Buffer.from(req.file.buffer).toString("base64");
        const dataURI = `data:${req.file.mimetype};base64,${b64}`;

        // 1. Upload para o Cloudinary
        const result = await cloudinary.uploader.upload(dataURI, {
            folder: CLOUDINARY_FOLDER, 
            tags: [FOLDER_TAG]        
        });
        
        const bannerUrl = result.secure_url;

        // 2. Define a nova posição (última)
        const currentSize = await redis.zcard(ACTIVE_BANNERS_KEY);
        const newPosition = currentSize;

        // 3. Adiciona a URL ao ZSET de banners ativos com a nova posição
        // 4. Adiciona a regra de dia no HASH
        await Promise.all([
            redis.zadd(ACTIVE_BANNERS_KEY, { score: newPosition, member: bannerUrl }),
            redis.hset(BANNER_DAYS_KEY, { [bannerUrl]: day })
        ]);

        console.log(`✅ Banner ${result.public_id} ativado com dia: ${day} e posição: ${newPosition}.`);
        res.status(201).json({ 
            message: 'Upload bem-sucedido e banner ativado!', 
            url: bannerUrl,
            day: day,
            position: newPosition
        });

    } catch (error) {
        console.error('❌ Erro ao processar upload:', error);
        return res.status(500).json({ error: 'Falha ao fazer upload.', details: error.message });
    }
});

/**
 * GET /api/banners: Lista todos os banners ATIVOS *PARA O DIA ATUAL* e ordenados.
 */
app.get('/api/banners', async (req, res) => {
    try {
        const today = new Date().getDay(); 
        const todayKey = DAYS_MAP[today];
        
        const activeBanners = await getActiveBannersOrdered();

        // Filtra banners que são 'ALL' ou correspondem ao dia de hoje
        const filteredUrls = activeBanners
            .filter(banner => banner.day === 'ALL' || banner.day === todayKey)
            .map(banner => banner.url);
        
        if (filteredUrls.length === 0) {
            console.log("ℹ️ Nenhum banner ativo encontrado para o dia de hoje.");
        }

        res.json({ banners: filteredUrls, day: todayKey });
        
    } catch (error) {
        console.error('❌ Erro ao carregar banners ativos do Redis:', error);
        return res.status(500).json({ error: 'Falha ao carregar banners ativos.' });
    }
});

/**
 * GET /api/banners/all: Lista todos os banners ATIVOS *com a regra de dia* e posição. (Para o Dashboard)
 */
app.get('/api/banners/all', async (req, res) => {
    try {
        const activeBanners = await getActiveBannersOrdered(); 
        
        if (activeBanners.length === 0) {
            console.log("ℹ️ Nenhum banner ativo encontrado.");
        }

        res.json({ banners: activeBanners });
        
    } catch (error) {
        console.error('❌ Erro ao carregar todos os banners ativos do Redis:', error);
        return res.status(500).json({ error: 'Falha ao carregar todos os banners ativos.' });
    }
});

/**
 * GET /api/banners/disabled: Lista todos os banners DESATIVADOS.
 */
app.get('/api/banners/disabled', async (req, res) => {
    try {
        const disabledUrls = await redis.smembers(DISABLED_BANNERS_KEY);
        if (disabledUrls.length === 0) {
            console.log("ℹ️ Nenhum banner desativado encontrado.");
        }
        res.json({ banners: disabledUrls });
        
    } catch (error) {
        console.error('❌ Erro ao carregar banners desativados do Redis:', error);
        return res.status(500).json({ error: 'Falha ao carregar banners desativados.' });
    }
});

/**
 * PUT /api/banners/disable: Move um banner de ativo para desativado no Redis.
 */
app.put('/api/banners/disable', async (req, res) => {
    const { url } = req.body; 

    if (!url) {
        return res.status(400).json({ error: 'A URL do banner é obrigatória.' });
    }

    try {
        // Remove do ZSET de ativos e do HASH de dias
        const [removedFromActive, removedDayRule] = await Promise.all([
            redis.zrem(ACTIVE_BANNERS_KEY, url),
            redis.hdel(BANNER_DAYS_KEY, url)
        ]);

        if (removedFromActive === 0) {
            const wasAlreadyDisabled = await redis.sismember(DISABLED_BANNERS_KEY, url);
            if(wasAlreadyDisabled) {
                 return res.status(404).json({ error: 'Banner já está na lista de desativados.' });
            }
            return res.status(404).json({ error: 'Banner não encontrado na lista de ativos.' });
        }

        // Adiciona ao SET de desativados
        await redis.sadd(DISABLED_BANNERS_KEY, url);

        console.log(`✔️ Banner desativado: ${url}`);
        return res.json({ message: 'Banner desativado com sucesso.', url });

    } catch (error) {
        console.error('❌ Erro ao desativar banner no Redis:', error);
        return res.status(500).json({ error: 'Falha ao desativar banner.' });
    }
});


/**
 * PUT /api/banners/enable: Move um banner de desativado para ativo no Redis, definindo o dia.
 */
app.put('/api/banners/enable', async (req, res) => {
    const { url, day } = req.body;
    
    // Day Validation
    const targetDay = day ? day.toUpperCase() : 'ALL';
    if (!url || !VALID_DAYS.includes(targetDay)) {
        return res.status(400).json({ error: 'A URL do banner é obrigatória e o dia deve ser válido.' });
    }

    try {
        // 1. Remove do SET de desativados
        const removedFromDisabled = await redis.srem(DISABLED_BANNERS_KEY, url);

        if (removedFromDisabled === 0) {
            const wasAlreadyActive = await redis.zscore(ACTIVE_BANNERS_KEY, url);
            if (wasAlreadyActive !== null) {
                return res.status(404).json({ error: 'Banner já está ativo.' });
            }
            return res.status(404).json({ error: 'Banner não encontrado na lista de desativados.' });
        }

        // 2. Define a nova posição (última)
        const currentSize = await redis.zcard(ACTIVE_BANNERS_KEY);
        const newPosition = currentSize;

        // 3. Adiciona ao ZSET de ativos e atualiza a regra de dia no HASH
        await Promise.all([
            redis.zadd(ACTIVE_BANNERS_KEY, { score: newPosition, member: url }),
            redis.hset(BANNER_DAYS_KEY, { [url]: targetDay })
        ]);

        console.log(`✔️ Banner reativado: ${url} para o dia: ${targetDay} e posição: ${newPosition}`);
        return res.json({ message: 'Banner reativado com sucesso.', url, day: targetDay, position: newPosition });

    } catch (error) {
        console.error('❌ Erro ao reativar banner no Redis:', error);
        return res.status(500).json({ error: 'Falha ao reativar banner.' });
    }
});

/**
 * PUT /api/banners/update-day: Atualiza o dia de exibição de um banner ATIVO.
 */
app.put('/api/banners/update-day', async (req, res) => {
    const { url, day } = req.body;
    
    // Day Validation
    const targetDay = day ? day.toUpperCase() : 'ALL';
    if (!url || !VALID_DAYS.includes(targetDay)) {
        return res.status(400).json({ error: 'A URL do banner é obrigatória e o dia deve ser válido.' });
    }
    
    try {
        // 1. Verifica se o banner existe no ZSET de ativos
        const currentPosition = await redis.zscore(ACTIVE_BANNERS_KEY, url);

        if (currentPosition === null) {
            return res.status(404).json({ error: 'Banner não encontrado na lista de ativos.' });
        }

        // 2. Atualiza o valor no HASH de dias
        await redis.hset(BANNER_DAYS_KEY, { [url]: targetDay });

        console.log(`🔄 Dia do Banner atualizado: ${url} para ${targetDay}.`);
        return res.json({ message: 'Dia de exibição atualizado com sucesso.', url, day: targetDay });

    } catch (error) {
        console.error('❌ Erro ao atualizar o dia do banner no Redis:', error);
        return res.status(500).json({ error: 'Falha ao atualizar o dia do banner.' });
    }
});

/**
 * PUT /api/banners/reorder: Atualiza a ordem dos banners ativos.
 * Recebe uma lista de URLs na ordem desejada.
 */
app.put('/api/banners/reorder', async (req, res) => {
    const { orderedUrls } = req.body;

    if (!Array.isArray(orderedUrls)) {
        return res.status(400).json({ error: 'Lista de URLs ordenadas é obrigatória.' });
    }

    try {
        // Cria um array de {score, member} para o comando ZADD
        const updates = orderedUrls.map((url, index) => ({
            score: index, // Posição (0, 1, 2, ...) é o novo score
            member: url
        }));

        if (updates.length === 0) {
             return res.status(200).json({ message: 'Nenhuma URL para reordenar.' });
        }
        
        // ZADD atualiza a posição dos membros existentes com novos scores.
        const updatedCount = await redis.zadd(ACTIVE_BANNERS_KEY, ...updates);

        console.log(`✨ Reordenação concluída. ${updatedCount} banners atualizados.`);
        return res.json({ message: 'Ordem dos banners atualizada com sucesso.', updatedCount });

    } catch (error) {
        console.error('❌ Erro ao reordenar banners no Redis:', error);
        return res.status(500).json({ error: 'Falha ao reordenar banners.' });
    }
});


/**
 * DELETE /api/banners: Exclui permanentemente o banner do Redis e Cloudinary.
 */
app.delete('/api/banners', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'A URL do banner é obrigatória para a exclusão.' });
    }

    try {
        // 1. Tenta remover a URL dos locais do Redis (Execução Paralela)
        const [removedActive, removedDayRule, removedDisabled] = await Promise.all([
            redis.zrem(ACTIVE_BANNERS_KEY, url), // Remove do ZSET
            redis.hdel(BANNER_DAYS_KEY, url), // Remove do HASH de dias
            redis.srem(DISABLED_BANNERS_KEY, url) // Remove do SET de desativados
        ]);
        
        const redisRemoved = removedActive + removedDisabled; 

        if (redisRemoved === 0 && removedDayRule === 0) {
            return res.status(404).json({ error: 'Banner não encontrado nos registros do Redis.' });
        }

        // 2. Extrai o public_id
        const publicId = extractPublicIdFromUrl(url);

        if (!publicId) {
             console.error(`⚠️ Falha ao extrair public_id de: ${url}. Apenas remoção do Redis realizada.`);
             return res.status(200).json({ 
                 message: 'Banner removido do Redis, mas falhou ao extrair o ID para exclusão no Cloudinary.', 
                 url, 
                 redisRemoved 
             });
        }

        // 3. Deleta do Cloudinary
        const destroyResult = await cloudinary.uploader.destroy(publicId); 
        
        let cloudinaryStatus = destroyResult.result;
        
        if (cloudinaryStatus === 'not found') {
             console.warn(`⚠️ Cloudinary: Arquivo ${publicId} não encontrado na nuvem, mas removido do Redis.`);
             cloudinaryStatus = 'removed_from_redis_only (file_not_found_on_cloud)';
        } else if (cloudinaryStatus !== 'ok') {
            console.error('❌ Erro ao deletar no Cloudinary:', destroyResult);
            return res.status(200).json({ 
                message: 'Banner removido do Redis, mas houve um erro na exclusão do Cloudinary.', 
                url, 
                cloudinaryStatus 
            });
        }

        console.log(`🔥 Banner EXCLUÍDO permanentemente: ${url}`);
        return res.json({ message: 'Banner excluído com sucesso.', url, redisRemoved, cloudinaryStatus: 'ok' });

    } catch (error) {
        console.error('❌ Erro ao excluir banner:', error);
        return res.status(500).json({ error: 'Falha ao excluir banner.' });
    }
});


// ------------------------------------------------------------------------
// --- 5. EXPORTAÇÃO VERCEL ---
// ------------------------------------------------------------------------
module.exports = app;