async function loadWeeklyPlan() {

    const {
        data: { session }
    } = await supabaseClient.auth.getSession();

    if (!session) {
        return;
    }

    const res = await fetch(
        "/api/training/get-week",
        {
            headers: {
                Authorization:
                    `Bearer ${session.access_token}`
            }
        }
    );

    const data = await res.json();

    if (!data.hasPlan) {
        renderNoPlan();
        return;
    }

    renderWeekHeader(data.plan);

    renderSessions(data.sessions);

}

function renderNoPlan() {

    document.getElementById("trainHeader").innerHTML = `
        <div class="empty-card">
            <h3>No training plan yet</h3>

            <p>
                Generate your first Athlevo week.
            </p>

            <button
                class="primary-btn"
                onclick="generateWeek()">

                Generate My Week

            </button>
        </div>
    `;

    document.getElementById("weekSessions").innerHTML = "";

}

function renderWeekHeader(plan){

    document.getElementById("trainHeader").innerHTML = `

        <div class="plan-header">

            <div class="plan-race">

                ${plan.target_race || "Training"}

            </div>

            <div class="plan-phase">

                ${plan.weeks_until_race ?? "-"} weeks until race

            </div>

            <h2>

                ${capitalize(plan.phase)}

            </h2>

            <p>

                Week ${plan.phase_week}
                of
                ${plan.phase_length_weeks}

            </p>

            <div class="week-focus">

                ${plan.week_focus}

            </div>

        </div>

    `;

}

function renderSessions(sessions){

    const container =
        document.getElementById("weekSessions");

    container.innerHTML="";

    sessions.forEach(session=>{

        const card =
            document.createElement("div");

        card.className="session-card";

        card.innerHTML=`

            <div class="session-date">

                ${session.session_date}

            </div>

            <h3>

                ${session.title}

            </h3>

            <div>

                ${session.duration_minutes ?? "-"} min

            </div>

            <div>

                ${session.session_type}

            </div>

        `;

        container.appendChild(card);

    });

}

async function generateWeek(){

    const {
        data:{session}
    } =
    await supabaseClient.auth.getSession();

    const button =
        event.target;

    button.disabled=true;

    button.innerText="Generating...";

    await fetch(
        "/api/training/generate-plan",
        {
            method:"POST",

            headers:{
                Authorization:
                    `Bearer ${session.access_token}`
            }
        }
    );

    await loadWeeklyPlan();

}

function capitalize(text){

    return text
        ? text.charAt(0).toUpperCase() +
          text.slice(1).replaceAll("_"," ")
        : "";

}

window.loadWeeklyPlan =
    loadWeeklyPlan;

window.generateWeek =
    generateWeek;