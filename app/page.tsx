
"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import Messenger from "./components/Messenger";

export default function Home() {
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadUser() {
      const { data, error } = await supabase.auth.getUser();

      if (!error && data.user) {
        setCurrentUserId(data.user.id);
      }

      setLoading(false);
    }

    loadUser();
  }, []);

  if (loading) {
    return <p>Chargement...</p>;
  }

  if (!currentUserId) {
    return <p>Connexion obligatoire. Reconnecte-toi.</p>;
  }

  return <Messenger currentUserId={currentUserId} />;
}
