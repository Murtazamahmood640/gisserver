import mongoose from 'mongoose';
import { Blog } from '../models/Blog';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const defaultBlogs = [
  {
    title: "The Ultimate Guide to Ceramic Coating",
    excerpt: "Everything you need to know about protecting your vehicle with ceramic coating for a long-lasting shine and superior protection.",
    content: `
      <p>Ceramic coating is one of the most effective ways to protect your vehicle's paint. It creates a semi-permanent bond with the surface, providing a layer of protection that lasts for years.</p>
      <h2>What is Ceramic Coating?</h2>
      <p>A ceramic coating is a liquid polymer that is applied by hand to the exterior of a vehicle. The coating chemically bonds with the vehicle's factory paint, creating a layer of protection.</p>
      <h2>Benefits of Ceramic Coating</h2>
      <ul>
        <li>Protection from UV damage and oxidation</li>
        <li>Protection from chemical stains and etching</li>
        <li>Ease of cleaning</li>
        <li>Enhanced gloss</li>
      </ul>
      <p>While ceramic coating is powerful, it's not a substitute for regular maintenance. You still need to wash your car regularly to keep it looking its best.</p>
    `,
    image: "https://images.unsplash.com/photo-1607860108855-64acf2078ed9?auto=format&fit=crop&q=80&w=1200",
    category: "Maintenance",
    author: "Admin",
    published: true,
    slug: "ultimate-guide-ceramic-coating"
  },
  {
    title: "5 Tips for Maintaining Your Car's Interior",
    excerpt: "Keep your car's interior looking brand new with these simple but effective maintenance tips from professional detailers.",
    content: `
      <p>The interior of your car is where you spend most of your time. Keeping it clean not only makes for a better driving experience but also preserves the value of your vehicle.</p>
      <h2>1. Vacuum Regularly</h2>
      <p>Dust and dirt can wear down your carpets and upholstery over time. Aim to vacuum at least once every two weeks.</p>
      <h2>2. Use the Right Cleaners</h2>
      <p>Avoid using harsh household chemicals on your car's interior surfaces. Use specialized automotive cleaners for leather, plastic, and fabric.</p>
      <h2>3. Protect from the Sun</h2>
      <p>UV rays can cause your dashboard to crack and your seats to fade. Use a sunshade when parked and apply a UV protectant to interior surfaces.</p>
    `,
    image: "https://images.unsplash.com/photo-1599256629751-4d74e637d405?auto=format&fit=crop&q=80&w=1200",
    category: "Maintenance",
    author: "Admin",
    published: true,
    slug: "tips-maintaining-car-interior"
  }
];

async function seed() {
  try {
    console.log("Connecting to database...");
    await mongoose.connect(process.env.MONGODB_URI!, { dbName: 'luxe-detail' });
    console.log("Connected.");

    console.log("Cleaning existing blogs...");
    await Blog.deleteMany({ author: "Admin" });

    console.log("Seeding default blogs...");
    await Blog.insertMany(defaultBlogs);

    console.log("Seeding complete!");
    process.exit(0);
  } catch (error) {
    console.error("Seeding error:", error);
    process.exit(1);
  }
}

seed();
