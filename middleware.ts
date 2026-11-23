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
  // The cookie name carries a fingerprint of the signing secret (see session-token.ts); the edge
  // runtime cannot read the secret, so any session-looking cookie passes this UX gate.
  if (request.cookies.getAll().some((cookie) => cookie.name.startsWith("ng_session") && cookie.value)) {
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
