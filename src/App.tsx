import { Header } from '@/components/Header';
import { Hero } from '@/components/Hero';
import { Features } from '@/components/Features';
import { Scenarios } from '@/components/Scenarios';
import { Install } from '@/components/Install';
import { Faq } from '@/components/Faq';
import { Footer } from '@/components/Footer';

export default function App() {
  return (
    <div className="min-h-screen">
      <Header />
      <main>
        <Hero />
        <Features />
        <Scenarios />
        <Install />
        <Faq />
      </main>
      <Footer />
    </div>
  );
}
