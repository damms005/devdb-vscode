export default {
  async fetch(request, env) {
    const { results } = await env.DB.prepare('SELECT * FROM customers').all();
    return Response.json(results);
  },
};
