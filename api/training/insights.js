/*
 * Athlevo — Training feedback and analysis gateway
 *
 * GET/POST /api/training/insights?action=check-in
 * GET      /api/training/insights?action=weekly-analysis
 */

import checkInHandler from "../../lib/server/training/check-in-route.js";
import weeklyAnalysisHandler from "../../lib/server/training/weekly-analysis-route.js";

export default async function handler(request, response) {
  const action = String(request.query?.action || "").toLowerCase();

  if (action === "check-in") {
    return checkInHandler(request, response);
  }

  if (action === "weekly-analysis") {
    return weeklyAnalysisHandler(request, response);
  }

  return response.status(400).json({
    error: "Unknown training insights action."
  });
}
