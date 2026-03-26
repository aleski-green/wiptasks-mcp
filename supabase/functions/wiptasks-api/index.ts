import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function err(message: string, status = 400) {
  return json({ error: message }, status);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const url = new URL(req.url);
  const path = url.pathname.split("/").pop();

  try {
    // --- GET routes ---
    if (req.method === "GET") {
      if (path === "active") {
        const { data, error } = await supabase
          .from("wiptasks")
          .select("*")
          .in("current_status", ["active", "new"])
          .order("priority", { ascending: false })
          .order("updated_at", { ascending: false });
        if (error) return err(error.message, 500);
        return json(data);
      }

      if (path === "last") {
        const { data, error } = await supabase
          .from("wiptasks")
          .select("*")
          .order("updated_at", { ascending: false })
          .limit(1)
          .single();
        if (error) return err(error.message, 500);
        return json(data);
      }

      if (path === "by-id") {
        const id = url.searchParams.get("id");
        if (!id) return err("Missing id parameter");
        const { data, error } = await supabase
          .from("wiptasks")
          .select("*")
          .eq("id", id)
          .single();
        if (error) return err(error.message, 404);
        return json(data);
      }

      if (path === "all") {
        const status = url.searchParams.get("status");
        let query = supabase.from("wiptasks").select("*");
        if (status) query = query.eq("current_status", status);
        query = query.order("updated_at", { ascending: false });
        const { data, error } = await query;
        if (error) return err(error.message, 500);
        return json(data);
      }

      return err("Unknown GET route. Use: active, last, by-id, all", 404);
    }

    // --- POST routes ---
    if (req.method === "POST") {
      const body = await req.json();

      if (path === "update") {
        const { id, ...updates } = body;
        if (!id) return err("Missing id");
        updates.updated_at = new Date().toISOString();
        const { data, error } = await supabase
          .from("wiptasks")
          .update(updates)
          .eq("id", id)
          .select()
          .single();
        if (error) return err(error.message, 500);
        return json(data);
      }

      if (path === "complete") {
        const { id } = body;
        if (!id) return err("Missing id");
        const { data, error } = await supabase
          .from("wiptasks")
          .update({ current_status: "completed", updated_at: new Date().toISOString() })
          .eq("id", id)
          .select()
          .single();
        if (error) return err(error.message, 500);
        return json(data);
      }

      if (path === "archive") {
        const { id } = body;
        if (!id) return err("Missing id");
        const { data, error } = await supabase
          .from("wiptasks")
          .update({ current_status: "archived", updated_at: new Date().toISOString() })
          .eq("id", id)
          .select()
          .single();
        if (error) return err(error.message, 500);
        return json(data);
      }

      if (path === "create") {
        const { data, error } = await supabase
          .from("wiptasks")
          .insert(body)
          .select()
          .single();
        if (error) return err(error.message, 500);
        return json(data, 201);
      }

      return err("Unknown POST route. Use: update, complete, archive, create", 404);
    }

    return err("Method not allowed", 405);
  } catch (e) {
    return err(e.message, 500);
  }
});
