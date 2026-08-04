export interface Env {
  ASSETS: any;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api.json") {
      url.pathname = "/_api.json";
    } else if (url.pathname === "/gpus.json") {
      url.pathname = "/_gpus.json";
    } else if (url.pathname === "/catalog.json") {
      url.pathname = "/_catalog.json";
    } else if (
      url.pathname === "/" ||
      url.pathname === "/index.html" ||
      url.pathname === "/index"
    ) {
      url.pathname = "/_index";
    } else if (isHtmlRoute(url.pathname)) {
      url.pathname = htmlRouteAssetPath(url.pathname);
    } else if (url.pathname.startsWith("/logos/")) {
      // Check if the specific provider logo exists in static assets
      const logoResponse = await env.ASSETS.fetch(
        new Request(url.toString(), request),
      );

      if (logoResponse.status === 404) {
        // Fallback to default logo
        const defaultUrl = new URL(url);
        defaultUrl.pathname = "/logos/default.svg";
        return await env.ASSETS.fetch(
          new Request(defaultUrl.toString(), request),
        );
      }

      return logoResponse;
    }

    const response = await env.ASSETS.fetch(new Request(url.toString(), request));
    if (response.status !== 404) return response;

    return new Response(null, {
      status: 302,
      headers: { Location: "/" },
    });
  },
};

function isHtmlRoute(pathname: string) {
  return (
    pathname === "/gpus" ||
    pathname === "/providers" ||
    pathname === "/regions" ||
    pathname.startsWith("/gpus/") ||
    pathname.startsWith("/providers/") ||
    pathname.startsWith("/regions/")
  );
}

function htmlRouteAssetPath(pathname: string) {
  const normalized =
    pathname !== "/" && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  return `${normalized}/index.html`;
}
