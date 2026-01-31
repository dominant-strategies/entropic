# Zara UX Revamp Plan v2
## "Create Your Assistant" - Refined User Experience

---

## Design Philosophy

**"Your Space, Your Assistant"**
- Zara is the system/platform, not the assistant itself
- Users create and name their own AI companion
- Subtle ambient Three.js backgrounds (not immersive VR-like)
- Purple accent throughout (#9333EA / #A855F7)
- Keep existing app structure - just elevate the aesthetics
- Desktop-only, no voice, cloud fallback option

**Target:** Everyday users creating their first AI assistant
**Principle:** Simple, warm, purple-accented, subtle depth

---

## Color System

**Primary Accent:** Purple
- Primary: `#9333EA` (purple-600)
- Light: `#A855F7` (purple-500)  
- Dark: `#7E22CE` (purple-700)
- Glow: `rgba(147, 51, 234, 0.3)`

**Background:**
- Deep: `#0F0A1A` (near black with purple tint)
- Gradient: `#0F0A1A` → `#1A0F2E` → `#0F0A1A`

**Glass Cards:**
- Background: `rgba(255, 255, 255, 0.05)`
- Border: `rgba(147, 51, 234, 0.1)`
- Blur: 16px

**Text:**
- Primary: `#FAFAFA` (white)
- Secondary: `rgba(255, 255, 255, 0.6)`
- Accent: `#A855F7`

---

## Phase 1: Boot Sequence (Loading Screen)

### Visual Design
- Full-screen with subtle animated gradient (deep purple tones)
- **Subtle** Three.js particle field in background
- Particles are sparse (30-40), slow-moving, low opacity
- Central logo text materializes gently

### Animation Sequence (6-8 seconds)
1. **0-2s**: Dark gradient, particles begin subtle drift
2. **2-4s**: "Zara" text fades in with soft purple glow
3. **4-6s**: Tagline appears below
4. **6-8s**: Fade to first onboarding screen

### Copy
- "Loading..."
- "Preparing your space..."

### Three.js Specs
- Particle count: 30-40 max
- Opacity: 0.3-0.5
- Movement: Slow drift, no user interaction
- Purpose: Ambient texture, not focal point

---

## Phase 2: Personal Onboarding

### Screen 1: Welcome
**Visual:**
- Full-screen soft gradient (static, not animated)
- Large centered typography
- Very subtle particle background (continues from boot)

**Copy:**
- "Hello."
- "Welcome to Zara."
- "The system designed to help you create your own AI assistant."

**Interaction:**
- Single "Get Started" button
- Purple glow on hover
- Click: smooth fade transition

---

### Screen 2: Name Your Assistant
**Visual:**
- Clean, centered layout
- Input field in glass card
- Helper text below

**Copy:**
- "What would you like to call your assistant?"
- Input placeholder: "e.g., Atlas, Nova, Companion..."
- Helper: "This is how you'll address your AI. You can change this anytime."

**Interaction:**
- Text input with purple focus glow
- Continue appears after 2+ characters
- Button: "Continue"

---

### Screen 3: What Will They Help You With?
**Visual:**
- Grid of glass selection cards (2x3)
- Cards have subtle depth but NOT 3D parallax
- Selected state: purple border + soft glow

**Options (choose 2-5):**
- 🧘 **Wellness** - "Health & mindfulness"
- 🌟 **Spirituality** - "Purpose & reflection"  
- 📰 **News** - "Stay informed"
- 🗳️ **Politics** - "Civic & current events"
- 💰 **Finance** - "Money & planning"
- 💻 **Work** - "Career & productivity"
- 🎨 **Creativity** - "Art & inspiration"
- 🏠 **Life** - "Daily tasks & organization"

**Interaction:**
- Click to toggle selection
- Purple checkmark appears on selected
- Progress: "2 of 5 selected"
- Continue activates at 2+

---

### Screen 4: How Should They Interact?
**Visual:**
- Three horizontal glass cards
- Simple, clean layout
- Icon + title + short description

**Options:**
1. **Professional** 💼
   - "Clear, efficient, business-focused"
   
2. **Friendly** 🌸
   - "Warm, conversational, supportive"
   
3. **Direct** ⚡
   - "Straightforward, no fluff, action-oriented"

**Interaction:**
- Single select
- Purple highlight on selection
- "This sounds right" button

---

### Screen 5: Choose Your Setup
**Visual:**
- Two glass cards side by side
- Clear visual distinction

**Copy:**
- "How would you like to run your assistant?"

**Options:**

**Option A: Local (Recommended)** 🏠
- "Runs on your computer"
- "Maximum privacy"
- "Free forever"
- "Takes 2 minutes to set up"

**Option B: Cloud** ☁️
- "Runs on our servers"
- "Instant setup"
- "Requires internet"
- "API key required"

**Interaction:**
- Select one
- Shows appropriate next steps
- Purple border on selected

---

## Phase 3: Setup Flow

### If Local Selected:

#### Step 1: Setup Method
**Visual:**
- Simple choice between two buttons

**Copy:**
- "Choose your setup method:"

**Options:**
- **Docker** (for Linux/Windows with Docker)
- **Colima** (for macOS - recommended)

**Interaction:**
- Button select
- Auto-detects OS, pre-selects recommendation

---

#### Step 2: Preparing Your Space
**Visual:**
- Full-screen glass overlay
- Center progress visualization
- Subtle purple particle background
- Progress bar with percentage

**Copy variations based on method:**

**For Colima:**
- "Setting up Colima..."
- "Building your secure environment..." (30-60s)
- "Connecting everything..."

**For Docker:**
- "Checking Docker..."
- "Building your secure environment..."
- "Almost ready..."

**Behind the scenes:**
- Check/install Colima or verify Docker
- Pull/build OpenClaw runtime
- Initialize container
- 30-90 seconds total

**Visual Progress:**
- Circular progress indicator
- Current step text
- "This keeps your data on your device"

---

#### Step 3: Add AI Service (Optional Skip)
**Visual:**
- Three service cards (Anthropic, OpenAI, Google)
- Each can be configured independently
- "Skip for now" option prominent

**Copy:**
- "Connect an AI service to get started"
- "Your keys stay on your computer"
- "You can add more later in settings"

**Interaction:**
- Click card to expand input
- Simple paste field
- "Verify & Connect" button
- Success: Purple checkmark, card glows
- Skip button at bottom

---

#### Step 4: Ready
**Visual:**
- Simple centered confirmation
- Purple pulse animation

**Copy:**
- "[Assistant Name] is ready."
- "Your personal assistant, running locally."

**Interaction:**
- Single "Meet [Name]" button
- Or auto-advance after 2 seconds

---

### If Cloud Selected:

#### Step 1: Choose AI Service
**Visual:**
- Same three service cards
- More prominent since cloud requires one

**Copy:**
- "Choose which AI service to use:"
- "Your API key is encrypted and secure"

**Interaction:**
- Must select one to continue
- Input field appears
- Verify connection
- Purple checkmark on success

---

#### Step 2: Ready
**Visual:**
- Same as local flow

**Copy:**
- "[Assistant Name] is ready."
- "Connected and ready to help."

---

### Error Handling (Friendly)
**Visual:**
- Soft red glow (not scary red)
- Gentle pulse

**Copy examples:**
- "Hmm, let me try a different approach..."
- "This is taking longer than expected..."
- "Need help?" (links to setup guide)

**Actions:**
- "Try again" button
- "Switch to cloud setup" option if local fails
- "Get help" link

---

## Phase 4: Main App (Refined, Not Rebuilt)

### Keep Current Structure
The existing layout stays largely the same:
- Sidebar navigation
- Main chat area
- Input at bottom
- Settings accessible

### Visual Upgrades (Purple Glass Theme)

#### Global Changes
- Background: Deep purple-tinted dark gradient
- All glass cards: Purple-tinted borders
- All interactive elements: Purple accent on hover
- Remove harsh borders, add subtle glows

#### 1. Sidebar
**Current structure preserved, visual polish:**

- **Logo area**: "Zara" text in purple gradient
- **New Chat**: Purple glow button, "+" icon
- **Chat history**: Glass chips with purple left border on active
- **Bottom nav**: Settings, etc. as subtle icons

**Styling:**
- 280px width (keep current)
- Glass morphism with purple tint
- Backdrop blur 16px
- Border: `1px solid rgba(147, 51, 234, 0.1)`

#### 2. Chat Area
**Structure preserved:**

**Message bubbles:**
- User: Right-aligned, purple-tinted glass `rgba(147, 51, 234, 0.1)`
- Assistant: Left-aligned, neutral glass `rgba(255, 255, 255, 0.05)`
- Both: 16px border radius, soft shadow
- Animation: Scale + fade in

**Empty state:**
- Centered glass card
- "What can [Assistant Name] help you with?"
- 3 suggestion chips in purple glass

**Input area:**
- Keep current position (bottom fixed)
- Glass input field
- Purple focus glow
- Placeholder: "message [name]..."
- Send button: Purple icon button inside input

#### 3. Settings Panel
**Simplified structure:**

**Sections:**
1. **Your Assistant** - Name, personality, interests
2. **AI Services** - API keys (simplified table view)
3. **Setup** - Local/Cloud, switch option

**Visual:**
- Slides in from right (keep current)
- Glass panel with purple accents
- Simple forms, clear labels

---

## Three.js Implementation (Subtle & Ambient)

### Philosophy
- Background texture, not focal point
- Low particle count (20-50)
- Slow, organic movement
- No user interaction with particles
- 30fps target (not 60, save battery)

### Components

#### 1. AmbientParticleField
**Usage:** All onboarding screens, loading states
```
- Count: 30 particles
- Size: 2-4px
- Opacity: 0.2-0.4
- Color: Purple-tinted white
- Movement: Gentle upward drift with slight horizontal sway
- Speed: Very slow (0.5px per frame)
```

#### 2. GentleGlowOrb
**Usage:** Behind logo on welcome screen
```
- Single soft orb
- Purple gradient
- Slow pulse animation (4s cycle)
- Low opacity (0.3)
```

#### 3. ProgressParticles
**Usage:** Setup progress visualization
```
- Particles orbit center point
- Purple color
- Speed increases with progress %
- Forms loose circle/spiral
```

### Performance Rules
- Pause when tab not visible
- Reduce particle count on low-end devices
- Use CSS animations where possible (less GPU)
- Three.js only for scenes that need depth

---

## Component Inventory

### Three.js Components (Subtle)
- `AmbientParticles` - Background texture
- `GlowOrb` - Single pulsing light
- `ProgressRing` - Setup visualization

### UI Components (Purple Glass)
- `GlassCard` - Base container
- `GlassButton` - Interactive buttons (purple accent)
- `GlassInput` - Text fields (purple focus)
- `SelectionCard` - Interest/personality selection
- `ServiceCard` - API key setup
- `SetupProgress` - Progress indicator with particles

### Screen Components
- `BootScreen` - Loading
- `WelcomeScreen` - Hello + intro
- `NameAssistantScreen` - Assistant naming
- `InterestsScreen` - Multi-select interests
- `PersonalityScreen` - Single select personality
- `SetupMethodScreen` - Local vs Cloud
- `LocalSetupScreen` - Docker/Colima flow
- `CloudSetupScreen` - Cloud flow
- `ReadyScreen` - Completion

---

## Copy Style Guide

**Tone:** Warm, empowering, simple
**Style:** Lowercase, conversational, user-centric
**Assistant-focused:** "Your assistant" not "Zara"

### Examples:

**Good:**
- "welcome to zara"
- "what will you call your assistant?"
- "your assistant runs on your computer"
- "meet atlas" (using their chosen name)
- "message atlas..." (input placeholder)
- "what can atlas help you with?"

**Bad:**
- "Welcome to Zara"
- "Configure your AI agent"
- "Local container deployment"
- "Docker initialization"
- "Enter your prompt"

---

## Technical Flow Summary

### New User Journey:
1. Boot → Loading with ambient particles
2. Welcome → "Welcome to Zara, create your assistant"
3. Name → User names their assistant
4. Interests → Select 2-5 focus areas
5. Personality → Choose interaction style
6. Setup Method → Local (Colima/Docker) or Cloud
7. **If Local:** Setup progress → Add AI service (optional) → Ready
8. **If Cloud:** Add AI service (required) → Ready
9. Main app → Chat with named assistant

### Key Differences from Current:
- Assistant is user-named, not "Zara"
- Cloud option available
- Colima specifically mentioned for macOS
- Setup is visual progress, not technical logs
- Purple theme throughout
- Subtle ambient backgrounds

---

## Success Metrics

1. **Onboarding completion:** > 85%
2. **Setup success (local):** > 75%
3. **Setup success (cloud):** > 90%
4. **Time to first message:** < 3 minutes
5. **User chooses local over cloud:** > 60% (privacy preference)
6. **Assistant name customization:** > 90% (not default)

---

## Implementation Priority

### Week 1: Foundation
1. Setup Three.js with ambient particles
2. Create purple glass design system
3. Build onboarding route structure
4. Create screen components (no logic)

### Week 2: Flow & Logic  
1. Build 8-step onboarding flow
2. Connect to existing backend commands
3. Implement setup progress (Docker/Colima)
4. Add cloud setup option

### Week 3: Polish
1. Add all micro-interactions
2. Refine Three.js performance
3. Test local vs cloud flows
4. Error handling & fallbacks

### Week 4: Main App
1. Apply purple glass theme to existing UI
2. Update copy to assistant-centric
3. Polish animations
4. Final testing

---

## Open Questions

1. **Default assistant name** - If they skip naming, use "assistant" or require it?
2. **Cloud service** - Do you have a cloud backend ready, or should this be phase 2?
3. **Interest categories** - Are the 8 I listed right, or adjust?
4. **Personality options** - Professional/Friendly/Direct work, or different?
5. **API key requirement** - Should cloud REQUIRE a key, or offer a free tier?

---

## Next Steps

Ready to start? I'll begin with:
1. Set up Three.js ambient particle system
2. Create purple glass component library
3. Build onboarding screen framework
4. Implement first 3 screens (Welcome, Name, Interests)

Confirm and I'll start Phase 1.
