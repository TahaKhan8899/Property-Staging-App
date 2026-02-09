# WH Staging Assistant (MVP)

**Automating the property staging workflow with Gemini 3 Pro and Nano Banana Pro.**

## Problem
The previous staging workflow was manual and repetitive, costing ~60-70 minutes per unit:
1. Manually selecting images.
2. Using ChatGPT with a persona to generate prompts.
3. Copy-pasting prompts into an image generator.
4. Repeating for every room.

## Goal
A single, minimal app to cut staging time by 50% by automating prompt generation and providing a unified interface for review and generation.

## Features
- **Project Structure**: Organize work by "Unit" (e.g., "B4 - WH Property").
- **Image Upload**: Upload 4-5 room images at once (JPG/PNG).
- **Room Labeling**: Tag images as Bedroom, Living Room, Kitchen, etc.
- **Auto-Prompter**: Uses **Gemini 3 Pro** to analyze rooms and generate detailed staging prompts based on a designer system prompt.
- **Review & Edit**: Manually review, edit, and approve prompts before generation.
- **2K Generation**: One-click generation of 2K, 16:9 staged images using **Nano Banana Pro**.
- **Comparison**: Side-by-side view of original vs. staged images.

## Technology Stack
- **Frontend**: React + TypeScript
- **AI Models**: 
  - Gemini 3 Pro (Prompt Generation & Image Analysis)
  - Nano Banana Pro (Image Generation)
- **State**: Local/In-memory (MVP)

## Local Setup

**Prerequisites:** Node.js

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure API Key:**
   - Create a `.env.local` file (optional, or enter key in UI).
   - Set `VITE_GEMINI_API_KEY=your_key_here`.

3. **Run the app:**
   ```bash
   npm run dev
   ```

This application was originally bootstrapped in Google AI Studio.
