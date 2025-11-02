import {Component, OnInit, inject, TransferState, makeStateKey} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import MarkdownIt from 'markdown-it';
import {firstValueFrom, Observable, of, tap} from 'rxjs';
import {isPlatformBrowser, NgIf} from "@angular/common";
import {PLATFORM_ID} from "@angular/core";
import {platformBrowser} from "@angular/platform-browser";

const TEST_KEY = makeStateKey<string>('testData');

@Component({
  selector: 'app-test',
  standalone: true,
  templateUrl: './test.component.html',
  imports: [
    NgIf
  ]
})
export class TestComponent implements OnInit {
  private http = inject(HttpClient);
  private platformId = inject(PLATFORM_ID); // ✅ inject it here
  private state = inject(TransferState);
  data: string | null = null;
  md = new MarkdownIt();

  ngOnInit() {
    this.loadData().subscribe(res => {
      this.data = res;
    });
  }

  loadData():Observable<any>{
    let response = this.state.get(TEST_KEY, null);
    if(response){
      this.state.remove(TEST_KEY);
      return of(response);
    }
    return this.http.get('/test', { responseType: 'text' })
      .pipe(tap((res)=>{
        this.state.set(TEST_KEY, this.md.render(res));
        return res;
    }));
  }
}
