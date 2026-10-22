// A meaning vector for each interest. Topics embed a written description. Phrases ("Claude",
// "DaVinci Resolve") embed the phrase blended with the average of recent stories that mention it,
// which pins down which "Claude" is meant. Refreshed every 6 hours as coverage shifts. Free, local.
import * as db from "./db.js";
import { embed, toPg } from "./embed.js";

export const TOPIC_TEXT = {
  us: "U.S. national news: American government, courts, crime, disasters, immigration and events across the United States",
  world: "International news: wars, diplomacy, foreign governments, elections and conflicts around the world",
  politics: "Politics: elections, campaigns, Congress, the White House, governors, parties and policy",
  business: "Business news: companies, earnings, deals, markets, CEOs, jobs and the economy",
  tech: "Technology and AI: gadgets, smartphones, software, tech companies, artificial intelligence and chatbots",
  science: "Science: research, discoveries, space, physics, biology, archaeology and new studies",
  health: "Health and medicine: diseases, treatments, doctors, hospitals, drugs, fitness and nutrition",
  climate: "Climate change and the environment: emissions, extreme weather, wildlife, conservation and clean energy",
  sports: "Sports: NFL, college football, NBA, MLB, soccer, golf, racing games, scores, players and teams",
  entertainment: "Entertainment: movies, TV shows, streaming, music, celebrities and pop culture",
  food: "Food and cooking: recipes, restaurants, chefs, kitchen tips and dining",
  travel: "Travel: destinations, trips, hotels, airlines, cruises, national parks and vacations",
  solar: "Solar power and energy: solar panels, home batteries, electric utilities, the power grid, EVs and clean energy",
};

const norm = v => { const n = Math.hypot(...v) || 1; return v.map(x => x / n); };
export const blend = (a, b, wa) => norm(a.map((x, i) => wa * x + (1 - wa) * b[i]));
export const mean = vs => norm(vs[0].map((_, i) => vs.reduce((s, v) => s + v[i], 0) / vs.length));

export async function refreshInterests() {
  if (process.env.DRY === "1") return 0;
  const list = await db.interestsPending();
  for (const it of list) {
    const topic = it.kind === "topic" ? TOPIC_TEXT[it.key.slice(2)] : null;
    const [base] = await embed([topic || it.label]);
    let vec = base;
    if (it.kind === "phrase" && it.terms) {
      const hits = await db.recentVectors(it.terms, 40);
      if (hits.length >= 5) vec = blend(base, mean(hits), 0.4);
    }
    await db.setInterestVec(it.id, toPg(vec));
  }
  if (list.length) console.log(`interests: ${list.length} vectors refreshed`);
  return list.length;
}
