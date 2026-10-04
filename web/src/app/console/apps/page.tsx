"use client";

import { useEffect, useState } from "react";
import { listApps, createApp, renameApp, deleteApp, type AppInfo } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { LayoutDashboard, Pencil, Plus, Trash2 } from "lucide-react";
import { useLocale } from "@/components/locale-provider";

// Apps are optional tenants: one integration environment each (e.g.
// douchat-prod). An API key issued in an app only sees the agents created
// in it; keys without an app see every agent of the account.
export default function AppsPage() {
  const { locale, tr } = useLocale();
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // editTarget null = closed; { id: "" } = create; otherwise rename.
  const [editTarget, setEditTarget] = useState<{ id: string; name: string } | null>(null);
  const [editName, setEditName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<AppInfo | null>(null);

  async function refresh() {
    const res = await listApps().catch(() => ({ error: tr("Failed to load apps", "加载应用失败") }));
    if ("apps" in res && res.apps) setApps(res.apps);
    if (res.error) setError(res.error);
    setLoading(false);
  }
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openEdit(app?: AppInfo) {
    setError("");
    setEditTarget(app ? { id: app.id, name: app.name } : { id: "", name: "" });
    setEditName(app?.name || "");
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!editTarget || !editName.trim()) return;
    const res = editTarget.id
      ? await renameApp(editTarget.id, editName.trim())
      : await createApp(editName.trim());
    if (res.error) {
      setError(res.error);
      return;
    }
    setEditTarget(null);
    refresh();
  }

  async function handleDelete(app: AppInfo) {
    const res = await deleteApp(app.id);
    if (res.error) setError(res.error);
    setDeleteTarget(null);
    refresh();
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">{tr("Apps", "应用")}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {tr(
              "Optional. An app is one integration environment, such as douchat-prod or douchat-dev. API keys issued in an app only see the agents created in it.",
              "可选。一个应用对应一个接入环境，例如 douchat-prod 或 douchat-dev。在应用里签发的 API 密钥只能看到该应用里创建的 Agent。",
            )}
          </p>
        </div>
        <Button onClick={() => openEdit()}>
          <Plus className="h-4 w-4 mr-2" />
          {tr("New app", "新建应用")}
        </Button>
      </div>

      {error && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="pt-6">
            <p className="text-sm text-destructive">{error}</p>
          </CardContent>
        </Card>
      )}

      {loading ? null : apps.length === 0 ? (
        <div className="rounded-lg border border-border bg-card">
          <div className="flex flex-col items-center justify-center py-16">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 mb-4">
              <LayoutDashboard className="h-7 w-7 text-primary" />
            </div>
            <p className="text-sm text-muted-foreground mb-1">{tr("No apps yet", "还没有应用")}</p>
            <p className="text-xs text-muted-foreground/60 mb-4 max-w-sm text-center">
              {tr(
                "You don't need one for a single integration: an API key without an app works with all your agents.",
                "只有一个接入方时不需要应用：不属于任何应用的 API 密钥可以使用你的全部 Agent。",
              )}
            </p>
            <Button variant="outline" size="sm" onClick={() => openEdit()}>
              <Plus className="h-4 w-4 mr-2" />
              {tr("New app", "新建应用")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tr("Name", "名称")}</TableHead>
                <TableHead>ID</TableHead>
                <TableHead>{tr("Agents", "Agent 数")}</TableHead>
                <TableHead>{tr("API keys", "密钥数")}</TableHead>
                <TableHead>{tr("Created", "创建时间")}</TableHead>
                <TableHead className="text-right">{tr("Actions", "操作")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apps.map((a) => {
                const empty = a.agentCount === 0 && a.keyCount === 0;
                return (
                  <TableRow key={a.id}>
                    <TableCell className="font-medium">{a.name}</TableCell>
                    <TableCell>
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{a.id}</code>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{a.agentCount}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{a.keyCount}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(a.createdAt).toLocaleString(locale === "zh-CN" ? "zh-CN" : "en-US")}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button size="icon" variant="ghost" onClick={() => openEdit(a)} title={tr("Rename", "重命名")}>
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          disabled={!empty}
                          onClick={() => setDeleteTarget(a)}
                          title={
                            empty
                              ? tr("Delete", "删除")
                              : tr("Delete its agents and API keys first", "请先删除它的 Agent 和 API 密钥")
                          }
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={editTarget !== null} onOpenChange={(o) => !o && setEditTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editTarget?.id ? tr("Rename app", "重命名应用") : tr("New app", "新建应用")}</DialogTitle>
            <DialogDescription>
              {tr(
                "Then issue API keys in it from the API Keys page; agents those keys create belong to the app.",
                "之后在 API 密钥页面为它签发密钥；这些密钥创建的 Agent 都归属该应用。",
              )}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSave} className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="app-name">{tr("Name", "名称")}</Label>
              <Input
                id="app-name"
                value={editName}
                maxLength={64}
                onChange={(e) => setEditName(e.target.value)}
                placeholder={tr("e.g. douchat-prod", "例如 douchat-prod")}
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditTarget(null)}>
                {tr("Cancel", "取消")}
              </Button>
              <Button type="submit" disabled={!editName.trim()}>
                {editTarget?.id ? tr("Save", "保存") : tr("Create app", "创建应用")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tr("Delete app?", "删除应用？")}</AlertDialogTitle>
            <AlertDialogDescription>
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{deleteTarget?.name}</code>{" "}
              {tr("has no agents or keys and will be removed.", "没有 Agent 和密钥，将被删除。")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tr("Cancel", "取消")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleteTarget && handleDelete(deleteTarget)}>
              {tr("Delete", "删除")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
