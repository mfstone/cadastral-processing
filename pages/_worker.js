/* The Pages project's only code: the routes _routes.json sends here (/api/*
   and the basemap archive) go to the Worker unchanged, so the Worker sees the
   page's own origin and the visitor's headers. Everything else is a static
   file Pages serves itself, with site/public/_headers applied. */
export default {
  fetch(request, env) {
    return env.APP.fetch(request);
  },
};
