"use client";

import { useEffect, useRef } from "react";
import "./TessInfiniteHero.css";

const slides = [
  {
    eyebrow: "AUTONOMY",
    title: "OFF-ROAD AUTONOMY.",
    image: "/images/tess-autonomy.jpg",
  },
  {
    eyebrow: "AI GNC",
    title: "PERCEPTION TO CONTROL.",
    image: "/images/tess-gnc.jpg",
  },
  {
    eyebrow: "MISSIONS",
    title: "BUILT FOR THE FIELD.",
    image: "/images/tess-mission.jpg",
  },
  {
    eyebrow: "FIELD PROOF",
    title: "PROOF, NOT PROMISES.",
    image: "/images/tess-field.jpg",
  },
];

export default function TessInfiniteHero() {
  const stageRef = useRef<HTMLDivElement>(null);
  const target = useRef(0);
  const current = useRef(0);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const cards = Array.from(
      stage.querySelectorAll<HTMLElement>(".tess-depth-card")
    );

    const onWheel = (e: WheelEvent) => {
      target.current += e.deltaY * 0.0015;
    };

    let frame = 0;

    const animate = () => {
      current.current +=
        (target.current - current.current) * 0.075;

      cards.forEach((card, i) => {
        /*
         * Infinite normalized position.
         * Each card continuously wraps back behind the scene.
         */
        let p =
          (i / cards.length + current.current) % 1;

        if (p < 0) p += 1;

        /*
         * 0 = far away
         * 1 = passing camera
         */
        const depth = p;

        const z = -1800 + depth * 2100;
        const scale = 0.48 + depth * 0.72;

        const opacity =
          depth < 0.08
            ? depth / 0.08
            : depth > 0.92
            ? (1 - depth) / 0.08
            : 1;

        const blur =
          Math.abs(depth - 0.72) * 5;

        card.style.transform = `
          translate3d(0, 0, ${z}px)
          scale(${scale})
        `;

        card.style.opacity =
          String(Math.max(0, opacity));

        card.style.filter =
          `blur(${blur}px)`;
      });

      frame = requestAnimationFrame(animate);
    };

    window.addEventListener("wheel", onWheel, {
      passive: true,
    });

    frame = requestAnimationFrame(animate);

    return () => {
      window.removeEventListener("wheel", onWheel);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <section className="tess-infinite-hero">

      {/* FIXED BRAND / UI */}
      <div className="tess-hero-copy">
        <span>DEFENCE-FIRST GROUND AUTONOMY</span>

        <h1>
          AUTONOMY
          <br />
          FOR THE
          <br />
          <em>REAL WORLD.</em>
        </h1>

        <p>
          AI-powered autonomy for demanding
          and contested environments.
        </p>
      </div>

      {/* DEPTH SCENE */}
      <div
        ref={stageRef}
        className="tess-depth-stage"
      >
        {slides.map((slide, index) => (
          <article
            className="tess-depth-card"
            key={index}
          >
            <img
              src={slide.image}
              alt=""
              draggable={false}
            />

            <div className="tess-card-overlay">
              <small>{slide.eyebrow}</small>
              <h2>{slide.title}</h2>
            </div>
          </article>
        ))}
      </div>

      <div className="tess-scroll-indicator">
        SCROLL TO EXPLORE
        <span>↓</span>
      </div>

    </section>
  );
}