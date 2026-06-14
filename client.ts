/**
 * Solo Empire API Client
 *
 * ใช้สำหรับดึงข้อมูลจาก Solo Empire Database
 * รองรับทั้ง local และ production (Cloudflare Tunnel)
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_SOLO_EMPIRE_API || 'http://localhost:3001';

export interface Profile {
  id: number;
  name: string | null;
  title: string | null;
  bio: string | null;
  tagline: string | null;
  location: string | null;
  email: string | null;
  website: string | null;
  avatar_url: string | null;
  header_image_url: string | null;
}

export interface SocialLink {
  id: number;
  platform: string;
  url: string;
  username: string | null;
  display_name: string | null;
  description: string | null;
  is_primary: boolean;
  sort_order: number;
}

export interface Skill {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  category_name: string | null;
  category_slug: string | null;
  level: string | null;
  target_level: string | null;
  status: string;
  priority: number;
  progress_percent: number;
  hours_invested: number;
}

export interface Asset {
  id: number;
  name: string;
  type: string;
  description: string | null;
  url: string | null;
  platform: string | null;
  status: string;
  monthly_value: number | null;
  total_value: number | null;
  views: number;
  subscribers: number;
  revenue: number;
}

export interface Content {
  id: number;
  title: string;
  slug: string;
  content_type: string;
  summary: string | null;
  body: string | null;
  status: string;
  published_at: string | null;
  platforms: string | null;
  canonical_url: string | null;
  views: number;
  shares: number;
}

class SoloEmpireAPI {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || API_BASE_URL;
  }

  private async fetch<T>(endpoint: string): Promise<T> {
    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        cache: 'no-store', // Always fetch fresh data
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`Failed to fetch ${endpoint}:`, error);
      throw error;
    }
  }

  /**
   * ดึงข้อมูล Profile + Social Links
   */
  async getProfile(): Promise<{ profile: Profile; socialLinks: SocialLink[] }> {
    return this.fetch('/api/profile');
  }

  /**
   * ดึง Skills ทั้งหมด (กรองตาม category/status ได้)
   */
  async getSkills(params?: { category?: string; status?: string }): Promise<{ skills: Skill[] }> {
    const queryParams = new URLSearchParams();
    if (params?.category) queryParams.append('category', params.category);
    if (params?.status) queryParams.append('status', params.status);

    const query = queryParams.toString();
    return this.fetch(`/api/skills${query ? `?${query}` : ''}`);
  }

  /**
   * ดึง Skill เดียวตาม slug
   */
  async getSkill(slug: string): Promise<{ skill: Skill }> {
    return this.fetch(`/api/skills/${slug}`);
  }

  /**
   * ดึง Assets ทั้งหมด
   */
  async getAssets(params?: { type?: string; status?: string }): Promise<{ assets: Asset[] }> {
    const queryParams = new URLSearchParams();
    if (params?.type) queryParams.append('type', params.type);
    if (params?.status) queryParams.append('status', params.status);

    const query = queryParams.toString();
    return this.fetch(`/api/assets${query ? `?${query}` : ''}`);
  }

  /**
   * ดึง Content ที่ publish แล้ว
   */
  async getContent(params?: { type?: string; limit?: number }): Promise<{ content: Content[] }> {
    const queryParams = new URLSearchParams();
    if (params?.type) queryParams.append('type', params.type);
    if (params?.limit) queryParams.append('limit', params.limit.toString());

    const query = queryParams.toString();
    return this.fetch(`/api/content${query ? `?${query}` : ''}`);
  }

  /**
   * ดึง Content เดียวตาม slug
   */
  async getContentBySlug(slug: string): Promise<{ content: Content }> {
    return this.fetch(`/api/content/${slug}`);
  }

  /**
   * ตรวจสอบว่า API ทำงานอยู่ไหม
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }
}

// Export singleton instance
export const soloEmpireAPI = new SoloEmpireAPI();

// Export class for custom instances
export { SoloEmpireAPI };
