import { redirect } from "next/navigation";

/** Signed-in users land on the worklist (patients are forwarded to their own glance page). */
export default function HomePage() {
  redirect("/patients");
}
