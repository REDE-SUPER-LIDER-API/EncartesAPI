//server.js

// Importações
const cloudinary = require('cloudinary').v2;
const Redis = require('ioredis');

// --- Configuração ---

// Configuração do Cloudinary (usando variáveis de ambiente)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

// Configuração do Upstash/Redis (usando a URL fornecida)
const redis = new Redis(process.env.UPSTASH_REDIS_URL);

/**
 * Função principal da API Vercel
 * @param {object} req - Objeto de Requisição
 * @param {object} res - Objeto de Resposta
 */
module.exports = async (req, res) => {
  try {
    // 1. Obter a lista de recursos do Cloudinary
    // O 'resource_type: "image"' garante que apenas imagens sejam buscadas.
    // O 'max_results: 10' limita a 10 para uma resposta rápida.
    const result = await cloudinary.api.resources({
      type: 'upload',
      prefix: '', // Busca em todos os diretórios.
      resource_type: 'image',
      max_results: 10
    });

    const images = result.resources;
    const imageList = [];

    // 2. Iterar sobre as imagens e obter metadados do Upstash
    for (const image of images) {
      const publicId = image.public_id;
      // Obter o URL do Cloudinary para a visualização
      const imageUrl = image.secure_url; 
      
      // A chave no Redis será o public_id da imagem
      const metadataJson = await redis.get(publicId); 
      let metadata = {};

      if (metadataJson) {
        // Analisar (parse) o JSON armazenado no Upstash
        metadata = JSON.parse(metadataJson); 
      }

      imageList.push({
        public_id: publicId,
        url: imageUrl,
        // Adiciona todos os metadados encontrados no Upstash
        metadata: metadata, 
        // Também adiciona algumas propriedades úteis do Cloudinary
        width: image.width,
        height: image.height,
        format: image.format
      });
    }

    // 3. Responder ao cliente
    res.status(200).json({
      success: true,
      count: imageList.length,
      images: imageList,
    });

  } catch (error) {
    console.error('Erro na API:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao processar a requisição',
      error: error.message
    });
  }
};