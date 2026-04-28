import * as THREE from "three";

const ZONES = [
  { name: "Resting",       max: 70,  color: 0x4ea0ff },
  { name: "Calm-Active",   max: 85,  color: 0x4edab1 },
  { name: "Engaged",       max: 100, color: 0xeacf56 },
  { name: "Elevated",      max: 120, color: 0xe88a3a },
  { name: "Stress / Peak", max: 200, color: 0xff5b6d }
];
const _stops = ZONES.map((z, i, arr) => ({
  v: i === 0 ? 60 : (arr[i - 1].max + Math.min(z.max, 160)) / 2,
  c: new THREE.Color(z.color),
  name: z.name
}));

export function zoneFor(bpm) {
  return ZONES.find(z => bpm <= z.max) ?? ZONES[ZONES.length - 1];
}
export function colorFor(bpm) {
  const s = _stops;
  if (bpm <= s[0].v) return s[0].c.clone();
  if (bpm >= s[s.length - 1].v) return s[s.length - 1].c.clone();
  for (let i = 0; i < s.length - 1; i++) {
    if (bpm <= s[i + 1].v) {
      const t = (bpm - s[i].v) / (s[i + 1].v - s[i].v);
      return s[i].c.clone().lerp(s[i + 1].c, t);
    }
  }
  return s[s.length - 1].c.clone();
}
export function stress(bpm) {
  return THREE.MathUtils.clamp((bpm - 70) / 70, 0, 1);
}