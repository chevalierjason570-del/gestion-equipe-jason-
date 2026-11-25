"use client";

import { useEffect, useState } from "react";
import { unzipSync, strFromU8 } from "fflate";

type Props = { url: string; fileName: string; onClose: () => void };
type Block = { type: "p" | "h" | "table" | "list"; text?: string; level?: number; rows?: string[][]; items?: string[] };

function nodeText(node: Element): string {
  return Array.from(node.childNodes).map(child => {
    if (child.nodeType === Node.TEXT_NODE) return child.textContent || "";
    if (child.nodeType !== Node.ELEMENT_NODE) return "";
    const el = child as Element;
    const name = el.localName;
    if (name === "s") return " ".repeat(Math.max(1, Number(el.getAttribute("text:c") || 1)));
    if (name === "tab") return "\t";
    if (name === "line-break") return "\n";
    return nodeText(el);
  }).join("");
}

function parseOdt(xml: string): Block[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("Le contenu du document ODT est illisible.");
  const body = doc.getElementsByTagNameNS("urn:oasis:names:tc:opendocument:xmlns:office:1.0", "body")[0];
  const textRoot = body?.getElementsByTagNameNS("urn:oasis:names:tc:opendocument:xmlns:office:1.0", "text")[0];
  if (!textRoot) throw new Error("Aucun texte n'a été trouvé dans ce document.");
  const blocks: Block[] = [];
  const walk = (parent: Element) => {
    for (const el of Array.from(parent.children)) {
      const name = el.localName;
      if (name === "p" || name === "h") {
        blocks.push({ type: name, text: nodeText(el), level: Number(el.getAttribute("text:outline-level") || 1) });
      } else if (name === "table") {
        const rows = Array.from(el.getElementsByTagNameNS("urn:oasis:names:tc:opendocument:xmlns:table:1.0", "table-row"))
          .map(row => Array.from(row.children).filter(cell => cell.localName === "table-cell" || cell.localName === "covered-table-cell").map(cell => nodeText(cell)));
        if (rows.length) blocks.push({ type: "table", rows });
      } else if (name === "list") {
        const items = Array.from(el.getElementsByTagNameNS("urn:oasis:names:tc:opendocument:xmlns:text:1.0", "list-item")).map(item => nodeText(item));
        if (items.length) blocks.push({ type: "list", items });
      } else if (name === "section") walk(el);
    }
  };
  walk(textRoot);
  return blocks;
}

export default function OdtPreview({ url, fileName, onClose }: Props) {
  const [blocks, setBlocks] = useState<Block[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Impossible de récupérer le document (${response.status}).`);
        const buffer = new Uint8Array(await response.arrayBuffer());
        const archive = unzipSync(buffer);
        const content = archive["content.xml"];
        if (!content) throw new Error("Ce fichier ne contient pas de document ODT valide.");
        const parsed = parseOdt(strFromU8(content));
        if (!cancelled) setBlocks(parsed);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Impossible d'afficher ce document.");
      }
    })();
    return () => { cancelled = true; };
  }, [url]);

  return <div role="dialog" aria-modal="true" aria-label={`Aperçu de ${fileName}`} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }} style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(15,23,42,.65)", display: "flex", alignItems: "center", justifyContent: "center", padding: 18 }}>
    <div style={{ width: "min(100%, 1000px)", height: "min(92vh, 900px)", background: "#e9edf3", borderRadius: 14, overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,.3)" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", background: "#172033", color: "white" }}>
        <strong style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>📄 {fileName}</strong>
        <button onClick={onClose} aria-label="Fermer l'aperçu" style={{ border: 0, borderRadius: 7, padding: "7px 12px", cursor: "pointer" }}>✕ Fermer</button>
      </header>
      <main style={{ flex: 1, overflow: "auto", padding: 24 }}>
        {!blocks && !error && <p style={{ textAlign: "center", color: "#475569" }}>Chargement de l'aperçu…</p>}
        {error && <p style={{ maxWidth: 650, margin: "40px auto", padding: 18, background: "white", borderRadius: 10, color: "#b91c1c" }}>{error}</p>}
        {blocks && <article style={{ maxWidth: 800, minHeight: 600, margin: "0 auto", padding: "55px 65px", background: "white", color: "#202124", boxShadow: "0 2px 12px rgba(0,0,0,.08)", fontFamily: "Arial, sans-serif", lineHeight: 1.65, overflowWrap: "anywhere" }}>
          {blocks.length === 0 ? <p>Ce document ne contient pas de texte affichable.</p> : blocks.map((block, index) => {
            if (block.type === "h") return <h2 key={index} style={{ fontSize: block.level === 1 ? 24 : 19, margin: "1.2em 0 .5em" }}>{block.text}</h2>;
            if (block.type === "table") return <table key={index} style={{ borderCollapse: "collapse", width: "100%", margin: "18px 0" }}><tbody>{block.rows?.map((row, ri) => <tr key={ri}>{row.map((cell, ci) => <td key={ci} style={{ border: "1px solid #9ca3af", padding: 7, verticalAlign: "top" }}>{cell}</td>)}</tr>)}</tbody></table>;
            if (block.type === "list") return <ul key={index}>{block.items?.map((item, i) => <li key={i}>{item}</li>)}</ul>;
            return <p key={index} style={{ minHeight: block.text ? undefined : 12, whiteSpace: "pre-wrap", margin: "0 0 10px" }}>{block.text}</p>;
          })}
        </article>}
      </main>
    </div>
  </div>;
}
