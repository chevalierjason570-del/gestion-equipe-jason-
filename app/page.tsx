"use client";

import { useState } from "react";

export default function Home() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loggedIn, setLoggedIn] = useState(false);

  function login(e: React.FormEvent) {
    e.preventDefault();

    if (username === "admin" && password === "admin123") {
      setLoggedIn(true);
    } else {
      alert("Identifiant ou mot de passe incorrect.");
    }
  }

  if (loggedIn) {
    return (
      <main style={{ padding: 40, fontFamily: "Arial" }}>
        <h1>Gestion Équipe Jason</h1>
        <h2>Bienvenue Administrateur !</h2>
        <p>Vous êtes connecté à votre espace administrateur.</p>
        <button onClick={() => setLoggedIn(false)}>Déconnexion</button>
      </main>
    );
  }

  return (
    <main style={{
      minHeight: "100vh",
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      background: "#eef2f7",
      fontFamily: "Arial"
    }}>
      <form onSubmit={login} style={{
        background: "white",
        padding: 35,
        borderRadius: 15,
        width: 320,
        boxShadow: "0 5px 25px #0002"
      }}>
        <h1>Gestion Équipe Jason</h1>
        <p>Connexion à votre compte</p>

        <label>Identifiant</label>
        <input
          value={username}
          onChange={e => setUsername(e.target.value)}
          required
          style={{ width: "100%", padding: 10, margin: "8px 0 18px" }}
        />

        <label>Mot de passe</label>
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          required
          style={{ width: "100%", padding: 10, margin: "8px 0 18px" }}
        />

        <button type="submit" style={{
          width: "100%",
          padding: 12,
          background: "#2563eb",
          color: "white",
          border: 0,
          borderRadius: 8,
          cursor: "pointer"
        }}>
          Se connecter
        </button>
      </form>
    </main>
  );
}
