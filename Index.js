// index.js (Arquivo na raiz do projeto)

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

// Configuração do Upstash/Redis
const redis = new Redis(process.env.UPSTASH_REDIS_URL);

/**
 * Função principal da API/Servidor Vercel.
 *
 * Se você acessar a URL raiz (e.g., SEU_PROJETO.vercel.app/),
 * esta função será executada.
 *
 * @param {object} req - Objeto de Requisição (Request)
 * @param {object} res - Objeto de Resposta (Response)
 */
module.exports = async (req, res) => {
  // O Vercel espera que a função retorne uma promessa ou use res.end() / res.json()
  
  if (req.method !== 'GET') {
    // Responde com o método não permitido
    return res.status(405).json({ 
        success: false, 
        message: 'Método não permitido. Use GET para listar as imagens.' 
    });
  }

  try {
    // 1. Obter a lista de recursos do Cloudinary
    console.log('Buscando recursos no Cloudinary...');
    const result = await cloudinary.api.resources({
      type: 'upload',
      prefix: '', 
      resource_type: 'image',
      max_results: 10
    });

    const images = result.resources;
    const imageList = [];

    // 2. Iterar sobre as imagens e obter metadados do Upstash
    for (const image of images) {
      const publicId = image.public_id;
      const imageUrl = image.secure_url; 
      
      // Busca metadados no Upstash usando o public_id como chave
      const metadataJson = await redis.get(publicId); 
      let metadata = {};

      if (metadataJson) {
        // Analisar (parse) o JSON armazenado
        metadata = JSON.parse(metadataJson); 
      }

      imageList.push({
        public_id: publicId,
        url: imageUrl,
        metadata: metadata, 
        width: image.width,
        height: image.height,
        format: image.format
      });
    }

    // 3. Responder ao cliente em formato JSON
    res.status(200).json({
      success: true,
      count: imageList.length,
      images: imageList,
    });

  } catch (error) {
    console.error('Erro na API:', error);
    // Envia um status 500 em caso de erro
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor ao processar a requisição',
      error: error.message
    });
  }
};