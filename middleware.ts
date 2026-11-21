import { NextResponse, type NextRequest } from "next/server";

/**
 * Page-level route protection. Requests for app pages without a session cookie are redirected to
 * /login. This is a UX gate only: every API route verifies the signed session server-side, so a
 * forged cookie gets a login page that cannot load any data.
 */
const PUBLIC_PAGES = ["/login", "/register", "/activate"];

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (PUBLIC_PAGES.some((page) => pathname === page || pathname.startsWith(`${page}/`))) {
    return NextResponse.next();
  }
  if (request.cookies.get("ng_session")?.value) {
    return NextResponse.next();
  }
  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = pathname === "/" ? "" : `?next=${encodeURIComponent(`${pathname}${search}`)}`;
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except API routes, Next internals and static files.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|webp|txt)$).*)"],
};
