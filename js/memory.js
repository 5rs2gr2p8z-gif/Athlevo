console.log("Athlevo Memory Loaded");

async function loadAthleteMemory() {
  const {
    data: { user },
  } = await supabaseClient.auth.getUser();

  if (!user) return [];

  const { data, error } = await supabaseClient
    .from("athlete_memory")
    .select("*")
    .eq("user_id", user.id)
    .order("importance", { ascending: false });

  if (error) {
    console.error(error);
    return [];
  }

  return data || [];
}

async function saveAthleteMemory(category, content, importance = 5) {
  const {
    data: { user },
  } = await supabaseClient.auth.getUser();

  if (!user) return;

  const { error } = await supabaseClient
    .from("athlete_memory")
    .insert({
      user_id: user.id,
      category,
      content,
      importance,
    });

  if (error) {
    console.error(error);
  }
}

window.AthlevoMemory = {
  loadAthleteMemory,
  saveAthleteMemory,
};