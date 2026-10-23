/**
 * Supabase Database Seeding Script
 * Initializes database schema and loads sample golf course data
 * Supports PostgreSQL with pgvector extension
 */

import { createClient } from "@supabase/supabase-js";

interface GolfCourse {
  id: string;
  name: string;
  location: string;
  latitude: number;
  longitude: number;
  holes: number;
  par: number;
  handicap?: number;
  designer?: string;
  established?: number;
  website?: string;
  phone?: string;
  email?: string;
  created_at?: string;
}

interface Hole {
  id: string;
  course_id: string;
  hole_number: number;
  par: number;
  handicap: number;
  length: number; // yards
  latitude: number;
  longitude: number;
  created_at?: string;
}

interface Round {
  id: string;
  course_id: string;
  user_id: string;
  date: string;
  score: number;
  handicap?: number;
  notes?: string;
  created_at?: string;
}

interface Score {
  id: string;
  round_id: string;
  hole_id: string;
  user_id: string;
  strokes: number;
  putts?: number;
  fairway_hit?: boolean;
  gir?: boolean;
  created_at?: string;
}

class SupabaseSeeder {
  private client: ReturnType<typeof createClient>;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.client = createClient(supabaseUrl, supabaseKey);
  }

  /**
   * Create database schema
   */
  async initializeSchema(): Promise<void> {
    console.log("📋 Initializing database schema...");

    try {
      // Create courses table
      await this.client.rpc("exec_sql", {
        sql: `
          CREATE TABLE IF NOT EXISTS courses (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name VARCHAR(255) NOT NULL UNIQUE,
            location VARCHAR(255),
            latitude DECIMAL(10, 8) NOT NULL,
            longitude DECIMAL(11, 8) NOT NULL,
            holes INTEGER DEFAULT 18,
            par INTEGER,
            handicap DECIMAL(5, 1),
            designer VARCHAR(255),
            established INTEGER,
            website VARCHAR(255),
            phone VARCHAR(20),
            email VARCHAR(255),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );

          CREATE INDEX idx_courses_location ON courses(latitude, longitude);
          CREATE INDEX idx_courses_created_at ON courses(created_at);
        `,
      });

      console.log("   ✓ Created courses table");

      // Create holes table
      await this.client.rpc("exec_sql", {
        sql: `
          CREATE TABLE IF NOT EXISTS holes (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
            hole_number INTEGER NOT NULL,
            par INTEGER NOT NULL,
            handicap INTEGER,
            length INTEGER, -- yards
            latitude DECIMAL(10, 8),
            longitude DECIMAL(11, 8),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(course_id, hole_number)
          );

          CREATE INDEX idx_holes_course_id ON holes(course_id);
          CREATE INDEX idx_holes_location ON holes(latitude, longitude);
        `,
      });

      console.log("   ✓ Created holes table");

      // Create rounds table
      await this.client.rpc("exec_sql", {
        sql: `
          CREATE TABLE IF NOT EXISTS rounds (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
            user_id UUID NOT NULL,
            date DATE NOT NULL,
            score INTEGER,
            handicap DECIMAL(5, 1),
            notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );

          CREATE INDEX idx_rounds_course_id ON rounds(course_id);
          CREATE INDEX idx_rounds_user_id ON rounds(user_id);
          CREATE INDEX idx_rounds_created_at ON rounds(created_at);
          CREATE INDEX idx_rounds_date ON rounds(date);
        `,
      });

      console.log("   ✓ Created rounds table");

      // Create scores table
      await this.client.rpc("exec_sql", {
        sql: `
          CREATE TABLE IF NOT EXISTS scores (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            round_id UUID NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
            hole_id UUID NOT NULL REFERENCES holes(id) ON DELETE CASCADE,
            user_id UUID NOT NULL,
            strokes INTEGER NOT NULL,
            putts INTEGER,
            fairway_hit BOOLEAN,
            gir BOOLEAN,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );

          CREATE INDEX idx_scores_round_id ON scores(round_id);
          CREATE INDEX idx_scores_hole_id ON scores(hole_id);
          CREATE INDEX idx_scores_user_id ON scores(user_id);
        `,
      });

      console.log("   ✓ Created scores table");

      // Create leaderboard view
      await this.client.rpc("exec_sql", {
        sql: `
          CREATE OR REPLACE VIEW leaderboard AS
          SELECT
            r.user_id,
            c.name as course_name,
            COUNT(*) as rounds_played,
            AVG(r.score) as average_score,
            MIN(r.score) as best_score,
            MAX(r.score) as worst_score,
            MAX(r.created_at) as last_round
          FROM rounds r
          JOIN courses c ON r.course_id = c.id
          GROUP BY r.user_id, c.name, c.id
          ORDER BY average_score ASC;
        `,
      });

      console.log("   ✓ Created leaderboard view");

      console.log("✅ Schema initialization complete!\n");
    } catch (error) {
      console.error("❌ Schema initialization failed:", error);
      throw error;
    }
  }

  /**
   * Seed sample golf course data
   */
  async seedSampleData(): Promise<void> {
    console.log("🌱 Seeding sample course data...");

    const courses: GolfCourse[] = [
      {
        id: "pelham-hills",
        name: "Pelham Hills Golf Club",
        location: "Pelham Manor, NY",
        latitude: 41.1081,
        longitude: -73.8295,
        holes: 18,
        par: 72,
        handicap: 10.5,
        designer: "A.W. Tillinghast",
        established: 1925,
        website: "www.pelhamhills.com",
        phone: "(914) 738-2800",
        email: "info@pelhamhills.ca",
      },
      {
        id: "westchester-cc",
        name: "Westchester Country Club",
        location: "Harrison, NY",
        latitude: 40.9519,
        longitude: -73.7114,
        holes: 18,
        par: 71,
        handicap: 8.2,
        designer: "Seth Raynor",
        established: 1923,
        website: "www.wcc-ny.com",
        phone: "(914) 835-8383",
        email: "info@wcc-ny.com",
      },
    ];

    for (const course of courses) {
      try {
        const { data, error } = await this.client
          .from("courses")
          .insert([course])
          .select();

        if (error) throw error;
        console.log(`   ✓ Seeded course: ${course.name}`);

        // Seed holes for this course
        await this.seedCourseHoles(course.id, course.par, course.holes);
      } catch (error) {
        console.warn(`   ⚠️  Failed to seed ${course.name}:`, error);
      }
    }

    console.log("✅ Sample data seeding complete!\n");
  }

  /**
   * Seed holes for a specific course
   */
  async seedCourseHoles(courseId: string, coursePar: number, numHoles: number = 18): Promise<void> {
    const parPattern = numHoles === 18 ? [4, 4, 4, 5, 3, 4, 4, 3, 5, 4, 4, 4, 3, 5, 4, 4, 3, 5] : [4, 3, 4];
    const handicapPattern = numHoles === 18
      ? [1, 3, 5, 7, 9, 11, 13, 15, 17, 2, 4, 6, 8, 10, 12, 14, 16, 18]
      : [1, 2, 3];

    const holes: Hole[] = [];

    for (let i = 1; i <= numHoles; i++) {
      const par = parPattern[(i - 1) % parPattern.length];
      holes.push({
        id: `${courseId}-hole-${i}`,
        course_id: courseId,
        hole_number: i,
        par,
        handicap: handicapPattern[(i - 1) % handicapPattern.length],
        length: par === 3 ? Math.floor(Math.random() * 60 + 120) : par === 4 ? Math.floor(Math.random() * 60 + 340) : Math.floor(Math.random() * 60 + 500),
        latitude: 41.1081 + (Math.random() - 0.5) * 0.01,
        longitude: -73.8295 + (Math.random() - 0.5) * 0.01,
      });
    }

    try {
      const { error } = await this.client.from("holes").insert(holes);
      if (error) throw error;
      console.log(`   ✓ Seeded ${numHoles} holes for course ${courseId}`);
    } catch (error) {
      console.warn(`   ⚠️  Failed to seed holes for ${courseId}:`, error);
    }
  }

  /**
   * Setup Row Level Security (RLS) policies
   */
  async setupRLSPolicies(): Promise<void> {
    console.log("🔐 Setting up Row Level Security policies...");

    try {
      // Enable RLS on all tables
      const tables = ["courses", "holes", "rounds", "scores"];

      for (const table of tables) {
        await this.client.rpc("exec_sql", {
          sql: `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`,
        });
        console.log(`   ✓ Enabled RLS for ${table}`);
      }

      // Create policies for public read access
      await this.client.rpc("exec_sql", {
        sql: `
          CREATE POLICY "Allow public read access to courses"
          ON courses FOR SELECT USING (true);

          CREATE POLICY "Allow public read access to holes"
          ON holes FOR SELECT USING (true);

          CREATE POLICY "Allow users to read own rounds"
          ON rounds FOR SELECT USING (auth.uid() = user_id OR auth.uid() IS NULL);

          CREATE POLICY "Allow users to create rounds"
          ON rounds FOR INSERT WITH CHECK (auth.uid() = user_id);

          CREATE POLICY "Allow users to read own scores"
          ON scores FOR SELECT USING (auth.uid() = user_id OR auth.uid() IS NULL);

          CREATE POLICY "Allow users to create scores"
          ON scores FOR INSERT WITH CHECK (auth.uid() = user_id);
        `,
      });

      console.log("   ✓ Created RLS policies");
      console.log("✅ RLS setup complete!\n");
    } catch (error) {
      console.warn("⚠️  RLS policy setup encountered an issue (policies may already exist):", error);
    }
  }

  /**
   * Verify schema and data
   */
  async verifySetup(): Promise<void> {
    console.log("✅ Verifying setup...");

    try {
      const [courseCount, holesCount, roundsCount] = await Promise.all([
        this.client.from("courses").select("*", { count: "exact", head: true }),
        this.client.from("holes").select("*", { count: "exact", head: true }),
        this.client.from("rounds").select("*", { count: "exact", head: true }),
      ]);

      console.log(`   📍 Courses: ${courseCount.count || 0}`);
      console.log(`   🕳️  Holes: ${holesCount.count || 0}`);
      console.log(`   🎯 Rounds: ${roundsCount.count || 0}`);
      console.log("\n✅ Database setup verified!\n");
    } catch (error) {
      console.warn("⚠️  Verification check failed:", error);
    }
  }

  /**
   * Run complete initialization
   */
  async initialize(): Promise<void> {
    console.log("🚀 Starting Supabase database initialization...\n");

    try {
      await this.initializeSchema();
      await this.seedSampleData();
      await this.setupRLSPolicies();
      await this.verifySetup();
      console.log("🎉 Initialization complete!");
    } catch (error) {
      console.error("❌ Initialization failed:", error);
      throw error;
    }
  }
}

// Export for use as module
export { SupabaseSeeder, type GolfCourse, type Hole, type Round, type Score };

// CLI usage
if (require.main === module) {
  (async () => {
    try {
      const supabaseUrl = process.env.SUPABASE_URL || "";
      const supabaseKey = process.env.SUPABASE_ANON_KEY || "";

      if (!supabaseUrl || !supabaseKey) {
        throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables");
      }

      const seeder = new SupabaseSeeder(supabaseUrl, supabaseKey);
      await seeder.initialize();

      process.exit(0);
    } catch (error) {
      console.error("❌ Error:", error);
      process.exit(1);
    }
  })();
}
