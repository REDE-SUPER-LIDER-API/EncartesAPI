// api/images.js

const cloudinary = require('cloudinary').v2;
const { Redis } = require('@upstash/redis');

// 1. Configuração do Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

// 2. Conexão com o Upstash Redis
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_URL,
  token: process.env.UPSTASH_REDIS_TOKEN,
});

// Chave Redis para armazenar a lista de IDs das imagens
const IMAGE_LIST_KEY = 'image_gallery_ids';

/**
 * Função principal do Vercel Serverless.
 * Roteia as requisições com base no método.
 */
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  try {
    switch (req.method) {
      case 'GET':
        await handleGetImages(res);
        break;
      case 'POST':
        // A lógica de POST abaixo é uma SIMULAÇÃO
        // de como o metadado seria salvo APÓS um upload.
        // O upload real de arquivos binários requer tratamento de
        // `multipart/form-data` (mais complexo em Vercel).
        await handleSimulateUpload(req, res);
        break;
      default:
        res.status(405).send({ message: 'Método não permitido.' });
    }
  } catch (error) {
    console.error('Erro na API:', error);
    res.status(500).send({ message: 'Erro interno do servidor', error: error.message });
  }
};

/**
 * Rota GET: Busca todos os metadados de imagens no Upstash e retorna os URLs.
 */
async function handleGetImages(res) {
  // 1. Pega a lista de todos os IDs de imagem salvos no Redis
  const imageIds = await redis.lrange(IMAGE_LIST_KEY, 0, -1);

  if (imageIds.length === 0) {
    return res.status(200).send({ images: [], message: 'Nenhuma imagem encontrada.' });
  }

  // 2. Busca todos os metadados (os HASHES) de uma vez
  const metadataPromises = imageIds.map(id => redis.hgetall(`image:${id}`));
  const metadatas = await Promise.all(metadataPromises);

  // 3. Filtra metadados nulos e formata a resposta
  const images = metadatas
    .filter(meta => meta !== null)
    .map(meta => ({
      id: meta.publicId,
      url: cloudinary.url(meta.publicId, { secure: true }), // Gera o URL seguro
      description: meta.description,
      uploadedAt: meta.uploadedAt,
    }));

  res.status(200).send({ images });
}

/**
 * Rota POST (Simulada): Simula o salvamento de metadados de imagem no Upstash.
 * No mundo real, isso viria DEPOIS do Cloudinary retornar o sucesso do upload.
 */
async function handleSimulateUpload(req, res) {
  // ⚠️ Substitua esta lógica por um upload real para o Cloudinary.
  // Aqui, SIMULAMOS que o Cloudinary retornou estes dados.
  const { publicId, description } = req.body; 

  if (!publicId) {
    return res.status(400).send({ message: 'Obrigatório fornecer o publicId para simulação.' });
  }

  // 1. Os dados que seriam salvos no Redis após um upload bem-sucedido
  const imageMetadata = {
    publicId: publicId, // Exemplo: 'user_photos/abc12345'
    description: description || 'Sem descrição',
    uploadedAt: new Date().toISOString(),
    // Outros dados do Cloudinary: format, version, etc.
  };

  // 2. Armazena o metadado da imagem usando um HASH (hash map)
  const imageKey = `image:${publicId}`;
  await redis.hset(imageKey, imageMetadata);

  // 3. Adiciona o ID da imagem à nossa lista (LIST) para fácil recuperação de todos
  await redis.lpush(IMAGE_LIST_KEY, publicId);

  res.status(201).send({
    message: 'Metadados da imagem salvos com sucesso no Upstash (Upload Cloudinary Simulado).',
    image: {
      publicId: publicId,
      url: cloudinary.url(publicId, { secure: true }),
    },
  });
}