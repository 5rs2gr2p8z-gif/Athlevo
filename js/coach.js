async function askCoach(question) {
    const profile = await AthlevoBrain.loadAthleteProfile();

    if (!profile) {
        console.error("No athlete profile found.");
        return;
    }

    const context = AthlevoBrain.buildCoachingContext(profile);

    console.log("======== ATHLEVO COACH ========");
    console.log("Question:", question);
    console.log("Context:", context);

    return {
        question,
        context
    };
}

window.askCoach = askCoach;