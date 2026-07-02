import { tool } from "ai";
import { z } from "zod";
import axios from "axios";

// Web search now lives in tools/circle.ts (paid via the x402 marketplace).

// ─── Calculator ───────────────────────────────────────────────────────────────

export const calculator = tool({
  description:
    "Evaluate mathematical expressions. Supports arithmetic, percentages, unit conversions. Examples: '15% of 847', '(23 * 4) + 100 / 2'",
  inputSchema: z.object({
    expression: z.string().describe("The math expression to evaluate"),
  }),
  execute: async ({ expression }) => {
    try {
      const sanitised = expression
        .replace(/[^0-9+\-*/.()%\s]/g, "")
        .replace(/%/g, "/100");
      // eslint-disable-next-line no-new-func
      const result = new Function(`"use strict"; return (${sanitised})`)();
      return { expression, result: Number(result.toFixed(10)) };
    } catch {
      return { error: `Could not evaluate: "${expression}"` };
    }
  },
});

// ─── DateTime ─────────────────────────────────────────────────────────────────

export const getDateTime = tool({
  description:
    "Get the current date and time. Also tells you the day of the week, UTC time, and the current timestamp.",
  inputSchema: z.object({
    timezone: z
      .string()
      .optional()
      .describe(
        "IANA timezone string e.g. 'Europe/London', 'America/New_York'. Defaults to UTC."
      ),
  }),
  execute: async ({ timezone }) => {
    const now = new Date();
    const tz = timezone ?? "UTC";
    try {
      const formatter = new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
      return {
        timezone: tz,
        formatted: formatter.format(now),
        utc: now.toUTCString(),
        iso: now.toISOString(),
        unixTimestamp: Math.floor(now.getTime() / 1000),
      };
    } catch {
      return { error: `Invalid timezone: "${tz}"` };
    }
  },
});

// ─── Weather (Open-Meteo — free, no API key needed) ───────────────────────────

export const getWeather = tool({
  description:
    "Get the current weather and 3-day forecast for any city worldwide. Returns temperature, conditions, humidity, and wind.",
  inputSchema: z.object({
    location: z
      .string()
      .describe("City name, e.g. 'London', 'New York', 'Lagos'"),
  }),
  execute: async ({ location }) => {
    try {
      const geoRes = await axios.get(
        "https://geocoding-api.open-meteo.com/v1/search",
        {
          params: {
            name: location,
            count: 1,
            language: "en",
            format: "json",
          },
        }
      );
      const place = geoRes.data?.results?.[0];
      if (!place) return { error: `Location "${location}" not found` };

      const weatherRes = await axios.get(
        "https://api.open-meteo.com/v1/forecast",
        {
          params: {
            latitude: place.latitude,
            longitude: place.longitude,
            current: [
              "temperature_2m",
              "relative_humidity_2m",
              "apparent_temperature",
              "weather_code",
              "wind_speed_10m",
            ].join(","),
            daily: ["temperature_2m_max", "temperature_2m_min"].join(","),
            forecast_days: 3,
            timezone: "auto",
          },
        }
      );

      const current = weatherRes.data?.current;
      const daily = weatherRes.data?.daily;

      const weatherCodes: Record<number, string> = {
        0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
        45: "Foggy", 51: "Light drizzle", 61: "Light rain", 63: "Rain",
        65: "Heavy rain", 71: "Light snow", 73: "Snow", 80: "Light showers",
        81: "Showers", 95: "Thunderstorm",
      };

      return {
        location: `${place.name}, ${place.country}`,
        current: {
          temperature: `${current.temperature_2m}°C`,
          feelsLike: `${current.apparent_temperature}°C`,
          conditions: weatherCodes[current.weather_code as number] ?? "Unknown",
          humidity: `${current.relative_humidity_2m}%`,
          windSpeed: `${current.wind_speed_10m} km/h`,
        },
        forecast: (daily.time as string[]).slice(0, 3).map((date, i) => ({
          date,
          high: `${(daily.temperature_2m_max as number[])[i]}°C`,
          low: `${(daily.temperature_2m_min as number[])[i]}°C`,
        })),
      };
    } catch (err) {
      return { error: `Weather fetch failed: ${(err as Error).message}` };
    }
  },
});
