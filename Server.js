// server.js (Refatorado: Sem Logística de Dias e Sem Limpeza Automática)

const express = require('express');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { Redis } = require('@upstash/redis');

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

// O ZSET ACTIVE_BANNERS_KEY guardará: {URL -> Score (Posição)}
const ACTIVE_BANNERS_KEY = 'active_banners_ordered'; 

const DISABLED_BANNERS_KEY = 'disabled_banner_urls'; 
const CLOUDINARY_FOLDER = 'banners_folder'; 
const FOLDER_TAG = 'banners_tag'; 

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
        // Exemplo: https://res.cloudinary.com/dvxxxxxx/image/upload/v1700000000/banners_folder/public_id_aqui.png
        const parts = url.split('/');
        
        // Verifica se a URL tem o formato esperado
        if (parts.length < 2) return null;
        
        // O nome do arquivo é o último item (excluindo a extensão)
        const fileNameWithExt = parts[parts.length - 1];
        const fileName = fileNameWithExt.substring(0, fileNameWithExt.lastIndexOf('.'));
        
        // O nome da pasta é o penúltimo item, garantindo que seja o folder que definimos
        const folderName = parts[parts.length - 2]; 
        
        if (folderName !== CLOUDINARY_FOLDER) return null;

        return `${folderName}/${fileName}`;

    } catch (e) {
        console.error('Erro ao extrair public_id:', e);
        return null;
    }
};

/**
 * Retorna os banners ativos com a respectiva posição.
 * @returns {Array<{url: string, position: number}>} Lista de banners ativos e ordenados.
 */
const getActiveBannersOrdered = async () => {
    // 1. Obtém todos os membros (URLs) e scores (posições) do ZSET, ordenados por score.
    // O 'true' no final retorna [member, score, member, score, ...]
    const zgetData = await redis.zrange(ACTIVE_BANNERS_KEY, 0, -1, { withScores: true });

    if (!zgetData || zgetData.length === 0) return [];

    // 2. Transforma o array em um array de objetos
    const bannersWithPosition = [];
    for (let i = 0; i < zgetData.length; i += 2) {
        // zgetData é [url, score, url, score, ...]
        bannersWithPosition.push({
            url: zgetData[i],
            position: parseInt(zgetData[i + 1])
        });
    }

    return bannersWithPosition;
};


// ------------------------------------------------------------------------
// --- 4. ROTAS ---
// ------------------------------------------------------------------------

/**
 * POST /api/encarte: Upload de imagem para o Cloudinary e ativação no Redis.
 */
app.post('/api/encarte', upload.single('bannerImage'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
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

        // 2. Define a nova posição como a última (score = tamanho atual do ZSET)
        const currentSize = await redis.zcard(ACTIVE_BANNERS_KEY);
        const newPosition = currentSize;

        // 3. Adiciona a URL ao ZSET de banners ativos com a nova posição
        await redis.zadd(ACTIVE_BANNERS_KEY, { score: newPosition, member: bannerUrl });


        console.log(`✅ Banner ${result.public_id} enviado e URL adicionada ao Redis com posição: ${newPosition}.`);
        res.status(201).json({ // 201 Created é mais adequado para POST de criação
            message: 'Upload bem-sucedido e banner ativado!', 
            url: bannerUrl,
            position: newPosition
        });

    } catch (error) {
        console.error('❌ Erro ao processar upload:', error);
        return res.status(500).json({ error: 'Falha ao fazer upload.', details: error.message });
    }
});

/**
 * GET /api/encarte: Lista todos os banners ATIVOS e ordenados (para o cliente).
 */
app.get('/api/encarte', async (req, res) => {
    try {
        // Obtém todas as URLs ativas e suas posições (já ordenado pela posição)
        const activeBanners = await getActiveBannersOrdered();

        const filteredUrls = activeBanners.map(banner => banner.url);
        
        if (filteredUrls.length === 0) {
            console.log("ℹ️ Nenhum banner ativo encontrado.");
        }

        // Retorna apenas a lista de URLs, já na ordem correta
        res.json({ banners: filteredUrls });
        
    } catch (error) {
        console.error('❌ Erro ao carregar banners ativos do Redis:', error);
        return res.status(500).json({ error: 'Falha ao carregar banners ativos.' });
    }
});

/**
 * GET /api/encarte/all: Lista todos os banners ATIVOS *com a posição*. (Para o Dashboard)
 */
app.get('/api/encarte/all', async (req, res) => {
    try {
        // Retorna a lista de objetos {url, position}
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
 * GET /api/encarte/disabled: Lista todos os banners DESATIVADOS.
 */
app.get('/api/encarte/disabled', async (req, res) => {
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
 * PUT /api/encarte/disable: Move um banner de ativo para desativado no Redis.
 */
app.put('/api/encarte/disable', async (req, res) => {
    const { url } = req.body; 

    if (!url) {
        return res.status(400).json({ error: 'A URL do banner é obrigatória.' });
    }

    try {
        // 1. Remove do ZSET de ativos (a posição/score é ignorada, ele só remove o membro)
        const removedFromActive = await redis.zrem(ACTIVE_BANNERS_KEY, url);

        if (removedFromActive === 0) {
            // Se não estava no ativo, verifica o desativado
            const wasAlreadyDisabled = await redis.sismember(DISABLED_BANNERS_KEY, url);
            if(wasAlreadyDisabled) {
                 return res.status(404).json({ error: 'Banner já está na lista de desativados.' });
            }
            return res.status(404).json({ error: 'Banner não encontrado na lista de ativos.' });
        }

        // 2. Adiciona ao SET de desativados
        await redis.sadd(DISABLED_BANNERS_KEY, url);

        console.log(`✔️ Banner desativado: ${url}`);
        return res.json({ message: 'Banner desativado com sucesso.', url });

    } catch (error) {
        console.error('❌ Erro ao desativar banner no Redis:', error);
        return res.status(500).json({ error: 'Falha ao desativar banner.' });
    }
});


/**
 * PUT /api/encarte/enable: Move um banner de desativado para ativo no Redis.
 */
app.put('/api/encarte/enable', async (req, res) => {
    const { url } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'A URL do banner é obrigatória.' });
    }

    try {
        // 1. Remove do SET de desativados
        const removedFromDisabled = await redis.srem(DISABLED_BANNERS_KEY, url);

        if (removedFromDisabled === 0) {
            // Se não estava no desativado, verifica se já está no ativo
            const wasAlreadyActive = await redis.zscore(ACTIVE_BANNERS_KEY, url);
            if (wasAlreadyActive !== null) {
                return res.status(404).json({ error: 'Banner já está ativo.' });
            }
            return res.status(404).json({ error: 'Banner não encontrado na lista de desativados.' });
        }

        // 2. Define a nova posição como a última (score = tamanho atual do ZSET)
        const currentSize = await redis.zcard(ACTIVE_BANNERS_KEY);
        const newPosition = currentSize;

        // 3. Adiciona ao ZSET de ativos com a nova posição
        await redis.zadd(ACTIVE_BANNERS_KEY, { score: newPosition, member: url });

        console.log(`✔️ Banner reativado: ${url} e posição: ${newPosition}`);
        return res.json({ message: 'Banner reativado com sucesso.', url, position: newPosition });

    } catch (error) {
        console.error('❌ Erro ao reativar banner no Redis:', error);
        return res.status(500).json({ error: 'Falha ao reativar banner.' });
    }
});

/**
 * PUT /api/encarte/reorder: Atualiza a ordem dos banners ativos.
 * Recebe uma lista de URLs na ordem desejada.
 */
app.put('/api/encarte/reorder', async (req, res) => {
    const { orderedUrls } = req.body;

    if (!Array.isArray(orderedUrls)) {
        return res.status(400).json({ error: 'Lista de URLs ordenadas é obrigatória.' });
    }

    try {
        // Cria um array de {score, member} para o comando ZADD
        const updates = orderedUrls.map((url, index) => ({
            score: index, // A posição na lista é o novo score (0, 1, 2, ...)
            member: url
        }));

        if (updates.length === 0) {
             return res.status(200).json({ message: 'Nenhuma URL para reordenar.' });
        }
        
        // O ZADD com novos scores atualiza a posição dos membros existentes.
        // O comando spread (...) garante que os elementos do array updates sejam passados como argumentos individuais.
        await redis.zadd(ACTIVE_BANNERS_KEY, ...updates);

        console.log(`✨ Reordenação concluída. ${updates.length} banners atualizados.`);
        return res.json({ message: 'Ordem dos banners atualizada com sucesso.', updatedCount: updates.length });

    } catch (error) {
        console.error('❌ Erro ao reordenar banners no Redis:', error);
        return res.status(500).json({ error: 'Falha ao reordenar banners.' });
    }
});


/**
 * DELETE /api/encarte: Exclui permanentemente o banner do Redis e Cloudinary.
 */
app.delete('/api/encarte', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'A URL do banner é obrigatória para a exclusão.' });
    }

    try {
        // 1. Tenta remover a URL dos locais do Redis
        const removedActive = await redis.zrem(ACTIVE_BANNERS_KEY, url); // Remove do ZSET
        const removedDisabled = await redis.srem(DISABLED_BANNERS_KEY, url); // Remove do SET de desativados
        
        const redisRemoved = removedActive + removedDisabled; // Contagem de ativo/desativado

        if (redisRemoved === 0) {
            return res.status(404).json({ error: 'Banner não encontrado nos registros do Redis.' });
        }

        // 2. Extrai o public_id da URL do Cloudinary
        const publicId = extractPublicIdFromUrl(url);

        if (!publicId) {
             console.error(`⚠️ Falha ao extrair public_id de: ${url}. Apenas remoção do Redis realizada.`);
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


// ------------------------------------------------------------------------
// --- ROTA DE LIMPEZA AUTOMÁTICA (CRON VERCEL) ---
// ------------------------------------------------------------------------

/**
 * POST /api/encarte/cleanup: Rota chamada pelo Cron Job do Vercel para executar a limpeza.
 * Exclui permanentemente todos os banners que estão na lista de DESATIVADOS.
 */
app.post('/api/encarte/cleanup', async (req, res) => {
    // 1. Verificação de Chave Secreta (Necessita da variável de ambiente CLEANUP_SECRET_KEY)
    const SECRET_KEY = process.env.CLEANUP_SECRET_KEY;
    // O Vercel envia a chave secreta no cabeçalho 'Authorization' como 'Bearer [chave]'
    const receivedKey = req.headers['authorization']; 
    
    const token = receivedKey ? receivedKey.replace('Bearer ', '') : null;

    if (!SECRET_KEY || token !== SECRET_KEY) {
        console.warn('❌ Tentativa de acesso não autorizado à rota de limpeza.');
        return res.status(401).json({ error: 'Acesso Não Autorizado. Chave Secreta Inválida.' });
    }

    // --- LÓGICA DE EXCLUSÃO AUTOMÁTICA ---
    try {
        const disabledUrls = await redis.smembers(DISABLED_BANNERS_KEY);
        let deletedCount = 0;
        let errors = 0;
        let skippedCount = 0;

        if (disabledUrls.length === 0) {
            console.log("🧹 Cleanup: Nenhum banner desativado para exclusão.");
            return res.status(200).json({ 
                message: 'Limpeza de banners desativados executada. Nenhum banner encontrado para exclusão.',
                banners_deleted: 0,
                errors_count: 0
            });
        }
        
        // Processa as exclusões em paralelo para maior eficiência
        const deletionPromises = disabledUrls.map(async (url) => {
            try {
                // Tenta remover do Redis
                const removedFromDisabled = await redis.srem(DISABLED_BANNERS_KEY, url);
                
                if (removedFromDisabled === 0) {
                    skippedCount++;
                    return; 
                }

                // Tenta excluir do Cloudinary
                const publicId = extractPublicIdFromUrl(url);
                if (publicId) {
                    const destroyResult = await cloudinary.uploader.destroy(publicId); 
                    if (destroyResult.result === 'ok' || destroyResult.result === 'not found') {
                         deletedCount++;
                    } else {
                        console.error(`❌ Cloudinary: Erro ao deletar ${publicId}:`, destroyResult);
                        errors++;
                    }
                } else {
                    console.error(`⚠️ Cleanup: Falha ao extrair public_id de: ${url}. Apenas remoção do Redis realizada.`);
                    deletedCount++; 
                }

            } catch (innerError) {
                console.error(`❌ Cleanup: Erro geral ao deletar o banner ${url}:`, innerError.message);
                errors++;
            }
        });

        await Promise.all(deletionPromises);
        
        console.log(`🧹 Tarefa de limpeza concluída. Banners excluídos: ${deletedCount}. Erros: ${errors}. Skipped: ${skippedCount}.`);
        
        return res.json({ 
            message: 'Limpeza de banners desativados executada com sucesso.',
            banners_deleted: deletedCount,
            errors_count: errors
        });

    } catch (error) {
        console.error('❌ Erro na rota de limpeza:', error);
        return res.status(500).json({ error: 'Falha ao executar a rotina de limpeza.' });
    }
});


// ------------------------------------------------------------------------
// --- 5. EXPORTAÇÃO VERCEL ---
// ------------------------------------------------------------------------
module.exports = app;