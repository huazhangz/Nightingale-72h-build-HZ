import { handleDemoBootstrap } from "../../../src/lib/api/handlers";

export async function GET() {
  return handleDemoBootstrap();
}
