const express = require("express");
const router = express.Router();
const ApplyJob = require("../models/ApplyJob");
const Job = require("../models/Job");
const SavedJob = require("../models/SavedJob");
const multer = require("multer");
const mongoose = require("mongoose");
const Candidate = require("../models/Candidate");
const Result = require("../models/Result");

// 🔥 OpenRouter se Groq Client par switch kiya
const OpenAI = require("openai");
const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

// ==========================
// MULTER CONFIG
// ==========================
const storage = multer.diskStorage({
  destination: (req, file, cb) => { cb(null, "uploads/"); },
  filename: (req, file, cb) => { cb(null, Date.now() + "-" + file.originalname); }
});
const upload = multer({ storage });

// =======================================================================
// ✅ 1. UPDATE APPLICATION STATUS
// =======================================================================
router.put("/update-application-status/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const updatedApp = await ApplyJob.findByIdAndUpdate(
      id,
      { status: status },
      { new: true }
    );

    if (!updatedApp) {
      return res.status(404).json({ error: "Application workflow record not found." });
    }

    res.status(200).json({ success: true, msg: `Status updated cleanly to ${status}!`, data: updatedApp });
  } catch (error) {
    console.error("Status update error:", error);
    res.status(500).json({ error: "Internal server error updating applicant status." });
  }
});

// =======================================================================
// ✅ 2. PERSISTENT INTERVIEW SCHEDULING DISPATCH ROUTE
// =======================================================================
router.put("/schedule-interview/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { status, interviewDate, interviewTime, interviewNotes } = req.body;

    const updatedInterviewRecord = await ApplyJob.findByIdAndUpdate(
      id,
      { 
        status: status || "Interview Scheduled", 
        interviewDate: interviewDate,
        interviewTime: interviewTime,
        interviewNotes: interviewNotes
      },
      { new: true }
    );

    if (!updatedInterviewRecord) {
      return res.status(404).json({ error: "The targeted application unit framework could not be located." });
    }

    res.status(200).json({ 
      success: true, 
      msg: "Interview scheduling metrics cataloged safely inside collection database framework ✅", 
      data: updatedInterviewRecord 
    });
  } catch (error) {
    console.error("Critical scheduling error:", error);
    res.status(500).json({ error: "Internal Server Error saving structural schedule updates." });
  }
});

// =======================================================================
// ✅ 3. GET ALL APPLICANTS FOR A SPECIFIC EMPLOYER (CRASH PROOF LOGIC)
// =======================================================================
router.get("/company-applicants/:companyEmail", async (req, res) => {
  try {
    const { companyEmail } = req.params;

    const companyJobs = await Job.find({ companyEmail }).select("_id jobTitle company skills projects description");
    if (!companyJobs.length) return res.status(200).json([]);

    const jobIds = companyJobs.map(job => job._id);
    
    const applications = await ApplyJob.find({ jobId: { $in: jobIds } }).lean();
    if (!applications.length) return res.status(200).json([]);

    const safeParseJson = (data, fallback) => {
      if (!data) return fallback;
      if (Array.isArray(data)) return data;
      try { return JSON.parse(data); } catch (e) {
        if (typeof data === "string") return data.split(",").map(item => item.trim());
        return fallback;
      }
    };

    const fullyCompiledApplicants = await Promise.all(
      applications.map(async (app) => {
        try {
          const targetJob = companyJobs.find(j => j._id?.toString() === app.jobId?.toString());
          let testRecord = null;

          if (app.userEmail) {
            const cleanEmail = app.userEmail.trim().toLowerCase();

            // 🔥 FIX: Corrupt Index Lock ko force-bypass karne ke liye standard casing match query use ki hai
            const candidateScores = await Result.find({ userEmail: cleanEmail })
              .sort({ completedAt: -1 })
              .hint({ _id: 1 }) // 👈 Forced to avoid corrupt indexing pipelines
              .lean();

            if (candidateScores && candidateScores.length > 0) {
              if (app.jobId) {
                const stringJobId = app.jobId.toString().trim();
                testRecord = candidateScores.find(scoreDoc => 
                  scoreDoc.jobId && scoreDoc.jobId.toString().trim() === stringJobId
                );
              }

              if (!testRecord) {
                testRecord = candidateScores[0]; 
              }
            }
          }

          const candidateProfile = app.userEmail ? await Candidate.findOne({ email: app.userEmail.trim() }).lean() : null;
          const skillsArray = safeParseJson(candidateProfile?.skills, ["MERN Stack"]);
          const projectsArray = safeParseJson(candidateProfile?.projects, []);
          const fallbackName = app.userEmail ? app.userEmail.split("@")[0] : "Candidate";
          const candidateName = candidateProfile?.name || fallbackName;
          const nameParts = candidateName.trim().split(" ");
          const firstName = nameParts[0] || "Candidate";
          const lastName = nameParts.slice(1).join(" ") || "";

          const finalScore = testRecord ? (testRecord.score !== undefined ? testRecord.score : 0) : 0;
          const finalTotalScore = testRecord ? (testRecord.total !== undefined ? testRecord.total : 10) : 10;
          const testPercentage = finalTotalScore > 0 ? (finalScore / finalTotalScore) * 100 : 0;

          let isAiRecommended = false;
          let aiReason = "Screening test score is below 80%.";

          if (testPercentage >= 80 && targetJob) {
            try {
              const aiResponse = await groq.chat.completions.create({
                model: "llama-3.1-8b-instant",
                messages: [
                  {
                    role: "system",
                    content: 'You are an expert technical recruiter. Return strictly a JSON object with two fields: "isRecommended" (boolean) and "reason" (string, max 1 sentence). No markdown formatting, no backticks.'
                  },
                  {
                    role: "user",
                    content: `JOB DETAILS: - Position: ${targetJob.jobTitle} - Skills: ${targetJob.skills ? targetJob.skills.join(", ") : "None"} \n CANDIDATE DETAILS: - Tech Skills: ${skillsArray.join(", ")} - Screening Test: ${testPercentage}% Score`
                  }
                ],
                response_format: { type: "json_object" }
              });

              const cleanResult = JSON.parse(aiResponse.choices[0].message.content.trim());
              isAiRecommended = cleanResult.isRecommended;
              aiReason = cleanResult.reason;
            } catch (aiError) {
              console.error("Groq Engine Error:", aiError);
              isAiRecommended = true;
              aiReason = "Highly recommended based entirely on screening test performance metrics.";
            }
          }

          return {
            _id: app._id,
            firstName,
            lastName,
            email: app.userEmail || "N/A",
            address: candidateProfile?.address || "Not Provided",
            github: candidateProfile?.github || "https://github.com",
            cv: candidateProfile?.cv || "",
            education: candidateProfile?.education || "N/A",
            experience: candidateProfile?.experience || "N/A",
            projects: projectsArray,
            skills: skillsArray,
            jobTitle: targetJob?.jobTitle || "Position",
            company: targetJob?.company || "Your Company",
            status: app.status || "Pending",
            score: finalScore,
            totalScore: finalTotalScore,
            createdAt: app.createdAt ? new Date(app.createdAt).toISOString().split("T")[0] : "-",
            isAiRecommended,
            aiReason
          };
        } catch (innerError) {
          console.error("Skipping corrupted applicant record:", innerError);
          return null;
        }
      })
    );

    res.status(200).json(fullyCompiledApplicants.filter(Boolean));
  } catch (error) {
    console.error("CRITICAL DASHBOARD FAILURE:", error);
    res.status(500).json({ error: error.message || "Failed aggregating data framework." });
  }
});

// =======================================================================
// ✅ 4. PREVIEW AI QUESTIONS (GROQ LLAMA3 - FREE)
// =======================================================================
router.post("/preview-ai-questions", async (req, res) => {
  try {
    const { aiPrompt } = req.body;

    if (!aiPrompt || aiPrompt.trim() === "") {
      return res.status(400).json({ error: "Prompt is required" });
    }

    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant", 
      messages: [
        {
          role: "system",
          content: `Return ONLY valid JSON. Absolutely no markdown text, no backticks (\`\`\`).
Format:
{
  "questions": [
    {
      "question": "Question text",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctAnswer": "Option A"
    }
  ]
}
Generate exactly 10 MCQs.`
        },
        {
          role: "user",
          content: `Generate exactly 10 job screening MCQs for: ${aiPrompt}`
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.4
    });

    const raw = completion.choices[0].message.content;
    const parsed = JSON.parse(raw);
    const questions = Array.isArray(parsed) ? parsed : parsed.questions;

    if (!Array.isArray(questions)) {
      throw new Error("AI did not return questions array");
    }

    res.status(200).json({ success: true, questions });
  } catch (error) {
    console.error("Groq AI Error:", error);
    res.status(500).json({ error: error.message || "Failed to generate MCQs" });
  }
});

// ==========================================
// OTHER PLATFORM ROUTES (RETAINED CLEANLY)
// ==========================================
router.get("/specific-test/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(jobId)) return res.status(400).json({ error: "Invalid target Job identifier." });
    const jobDocument = await Job.findById(jobId).select("testQuestions jobTitle company");
    if (!jobDocument) return res.status(404).json({ error: "Job opening could not be located." });
    res.status(200).json({ success: true, jobTitle: jobDocument.jobTitle, company: jobDocument.company, questions: jobDocument.testQuestions || [] });
  } catch (error) { res.status(500).json({ error: "Server structural processing failure." }); }
});

router.post("/post-job", upload.single("logo"), async (req, res) => {
  try {
    const data = req.body;
    if (!data.companyEmail) return res.status(400).json({ error: "Company email is required" });
    let skills = data.skills ? JSON.parse(data.skills) : [];
    let projects = data.projects ? JSON.parse(data.projects) : [];
    let finalTestQuestions = data.testQuestions ? JSON.parse(data.testQuestions) : [];
    if (finalTestQuestions.length === 0) return res.status(400).json({ error: "Screening test is required to post this job" });
    
    const newJob = new Job({
      jobTitle: data.jobTitle, jobType: data.jobType, shift: data.shift, jobMode: data.jobMode, experience: data.experience,
      salary: { min: Number(data.minSalary), max: Number(data.maxSalary), currency: data.currency },
      category: data.category, careerLevel: data.careerLevel, vacancies: Number(data.vacancies), qualification: data.qualification,
      company: data.company, companyEmail: data.companyEmail, location: data.location, description: data.description,
      skills, projects, testQuestions: finalTestQuestions, logo: req.file ? req.file.filename : ""
    });
    await newJob.save();
    res.status(200).json({ success: true, message: "Job Posted Successfully with Screening Test ✅" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/all-jobs", async (req, res) => {
  try { const jobs = await Job.find().sort({ createdAt: -1 }); res.json(jobs || []); } 
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/my-jobs/:companyEmail", async (req, res) => {
  try { const jobs = await Job.find({ companyEmail: req.params.companyEmail }).sort({ createdAt: -1 }); res.json(jobs || []); } 
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete("/delete-job/:id/:companyEmail", async (req, res) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job || job.companyEmail !== req.params.companyEmail) return res.status(403).json({ msg: "Not allowed" });
    await Job.findByIdAndDelete(req.params.id);
    await SavedJob.deleteMany({ jobId: req.params.id });
    res.json({ msg: "Deleted successfully ✅" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/company-name/:email", async (req, res) => {
  try {
    const job = await Job.findOne({ companyEmail: req.params.email });
    if (!job) return res.json({ companyName: "Your Company", logo: "" });
    res.json({ companyName: job.company, logo: job.logo });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/save-job", async (req, res) => {
  try {
    const { userEmail, jobId } = req.body;
    const alreadySaved = await SavedJob.findOne({ userEmail, jobId });
    if (alreadySaved) return res.json({ msg: "Already saved" });
    await new SavedJob({ userEmail, jobId }).save();
    res.json({ msg: "Job saved successfully ✅" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/saved-jobs/:email", async (req, res) => {
  try {
    const saved = await SavedJob.find({ userEmail: req.params.email }).populate("jobId");
    res.json(saved.map(item => item.jobId).filter(Boolean));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/recent-jobs", async (req, res) => {
  try {
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    const jobs = await Job.find({ createdAt: { $gte: yesterday } }).sort({ createdAt: -1 });
    res.json(jobs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/apply-job", async (req, res) => {
  try {
    const { userEmail, jobId } = req.body;
    const alreadyApplied = await ApplyJob.findOne({ userEmail, jobId });
    if (alreadyApplied) return res.json({ msg: "Already applied ❗" });
    await new ApplyJob({ userEmail, jobId, status: "Pending" }).save();
    res.json({ msg: "Applied successfully ✅" });
  } catch (err) { res.status(500).json({ msg: "Server error" }); }
});

router.get("/applied-jobs/:email", async (req, res) => {
  try {
    const apps = await ApplyJob.find({ userEmail: req.params.email }).populate("jobId");
    
    const formattedApplications = apps.map(app => {
      if (!app.jobId) return null;
      
      return {
        _id: app._id,
        applicationId: app._id,
        status: app.status || "Pending",
        interviewDate: app.interviewDate || "",
        interviewTime: app.interviewTime || "",
        interviewNotes: app.interviewNotes || "",
        jobId: app.jobId._id,
        company: app.jobId.company || "Corporate System",
        jobTitle: app.jobId.jobTitle || "Developer",
        location: app.jobId.location || "N/A"
      };
    }).filter(Boolean);

    res.json(formattedApplications);
  } catch (err) {
    console.error("Error structural fetching user tracking jobs:", err);
    res.status(500).json({ msg: "Error fetching components applications payload framework" });
  }
});

module.exports = router;