"use client";

import { redirect } from "next/navigation";

// /admin is the deployment-wide area for super_admins; its first page is
// Users.
export default function AdminIndex() {
  redirect("/admin/users/");
}
