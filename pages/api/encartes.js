import { v2 as cloudinary } from 'cloudinary';

// 1. Configuração do Cloudinary
// As credenciais são carregadas automaticamente das variáveis de ambiente
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true, // Garante que as URLs geradas sejam HTTPS
});

// A função 'handler' é a Serverless Function que será executada pelo Vercel
export default async function handler(req, res) {
  // Configuração da Tag
  const ENCARTE_TAG = 'encarte'; // Use a tag que você aplicou às suas imagens no Cloudinary

  // Verifica o Método HTTP
  if (req.method !== 'GET') {
    // Retorna 405 (Method Not Allowed) para outros métodos
    return res.status(405).json({ message: 'Método não permitido. Use GET.' });
  }

  try {
    // 2. Busca de Recursos no Cloudinary
    // O método .search() permite buscar recursos por tipo, tag, etc.
    const result = await cloudinary.search
      // Filtra por imagens E pela tag 'encarte'
      .expression(`resource_type:image AND tags:${ENCARTE_TAG}`) 
      .max_results(100) // Limita o número de resultados (máximo 500)
      .execute();

    // 3. Mapeamento e Formatação da Resposta
    // Mapeamos para retornar apenas as propriedades essenciais
    const encartes = result.resources.map(resource => ({
      id: resource.public_id,
      url: resource.secure_url,
      // Você pode adicionar otimizações de URL aqui, se desejar
      width: resource.width,
      height: resource.height,
    }));

    // 4. Retorno de Sucesso
    res.status(200).json({ 
      success: true,
      count: encartes.length,
      encartes: encartes 
    });

  } catch (error) {
    console.error('Erro ao buscar encartes:', error);
    // Retorno de Erro
    res.status(500).json({ 
      success: false,
      message: 'Falha interna ao buscar imagens de encartes.',
      errorDetail: error.message // Útil para debug
    });
  }
}