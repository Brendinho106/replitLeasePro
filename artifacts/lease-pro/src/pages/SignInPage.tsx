import { SignIn } from "@clerk/react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-primary px-4 py-12 relative overflow-hidden">
      {/* Decorative background elements matching the forest green brand */}
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] rounded-full bg-white/5 blur-3xl" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] rounded-full bg-white/5 blur-3xl" />
      </div>
      
      <div className="w-full max-w-[440px] flex flex-col items-center gap-8 relative z-10">
        <div className="flex flex-col items-center gap-3">
          <img src={`${basePath}/logo.svg`} alt="LeasePro" className="w-12 h-12 rounded-xl shadow-lg ring-1 ring-white/20" />
          <span className="font-serif font-semibold text-2xl text-white tracking-tight">LeasePro</span>
        </div>
        
        <div className="w-full relative shadow-2xl">
          <SignIn 
            routing="path" 
            path={`${basePath}/sign-in`} 
            signUpUrl={`${basePath}/sign-up`}
            fallbackRedirectUrl={`${basePath}/chat`}
          />
        </div>
      </div>
    </div>
  );
}
